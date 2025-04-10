import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import express from 'express';
import mime from 'mime-types';

// 1. Загружаем конфигурацию
dotenv.config();

// 2. Получаем токен
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Токен бота не найден! Проверьте файл .env');
  process.exit(1);
}

// 3. Определяем режим работы
const isRailway = process.env.RAILWAY_ENVIRONMENT === 'production';

// 4. Инициализируем бота
const bot = new TelegramBot(token, {
  polling: false // Всегда отключаем polling для Railway
});

console.log(`🚀 Бот запущен в режиме ${isRailway ? 'production (Railway)' : 'разработки'}`);

// Константы
const PDF_BASE_PATH = './pdfs/';
const ADMIN_ID = process.env.ADMIN_ID || '199775458';
const STATS_FILE = path.join(process.cwd(), 'bot_stats.json');

// Инициализация файла статистики
function initStats() {
  if (!fs.existsSync(STATS_FILE)) {
    const defaultData = {
      totalUsers: 0,
      activeUsers: [],
      arcanaRequests: {},
      arcanaSent: {},
      linkClicks: { ZAZINA_TATYANA: 0, Zazina_TD: 0 },
      commandUsage: {}
    };
    fs.writeFileSync(STATS_FILE, JSON.stringify(defaultData, null, 2)); // Добавьте null, 2 для читаемости
    console.log('Файл статистики инициализирован'); // Отладочное сообщение
  }
}

// Обновление статистики
function updateStats(type, data) {
  initStats();
  const stats = JSON.parse(fs.readFileSync(STATS_FILE));

  switch(type) {
    case 'new_user':
      stats.totalUsers += 1;
      stats.activeUsers.push({
        id: data.chatId,
        username: data.username,
        firstInteraction: new Date().toISOString()
      });
      break;

    case 'arcana':
      stats.arcanaRequests[data.arcanumNumber] = (stats.arcanaRequests[data.arcanumNumber] || 0) + 1;
      break;

    case 'arcana_sent':
      if (!stats.arcanaSent[data.arcanumNumber]) {
        stats.arcanaSent[data.arcanumNumber] = {
          count: 0,
          users: []
        };
      }
      stats.arcanaSent[data.arcanumNumber].count += 1;
      stats.arcanaSent[data.arcanumNumber].users.push({
        id: data.chatId,
        date: new Date().toISOString()
      });
      break;

    case 'link_click':
      stats.linkClicks[data.linkName] = (stats.linkClicks[data.linkName] || 0) + 1;
      break;

    case 'command':
      stats.commandUsage[data.command] = (stats.commandUsage[data.command] || 0) + 1;
      break;
  }

  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
      console.log('Статистика обновлена'); // Подтверждение записи
    } catch (err) {
      console.error('Ошибка в updateStats:', err);
    }
  }

// Состояния пользователя
const UserState = {
    START: 'START',
    WAITING_FOR_GENDER: 'WAITING_FOR_GENDER',
    WAITING_FOR_NAME: 'WAITING_FOR_NAME',
    CONFIRM_NAME: 'CONFIRM_NAME',
    WAITING_FOR_BIRTHDATE: 'WAITING_FOR_BIRTHDATE',
    CONFIRM_BIRTHDATE: 'CONFIRM_BIRTHDATE',
    WAITING_FOR_MORE: 'WAITING_FOR_MORE'
};

// Настройка Express
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// Обработчик webhook
app.post('/webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Установка webhook (только для Railway)
if (process.env.RAILWAY_ENVIRONMENT === 'production') {
  const domain = process.env.RAILWAY_STATIC_URL;

  if (!domain) {
    console.error('❌ RAILWAY_STATIC_URL не настроен!');
    process.exit(1);
  }

  const webhookUrl = `${domain}/webhook`;

  bot.setWebHook(webhookUrl)
    .then(() => console.log(`✅ Webhook установлен на ${webhookUrl}`))
    .catch(err => console.error('❌ Ошибка webhook:', err));
}

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});

// Хранилища данных
const userStates = new Map();
const userData = new Map();

// Обработчики сообщений
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || '';
    const state = userStates.get(chatId) || UserState.START;

    try {
        if (text === '/start') {
            updateStats('new_user', {
                chatId,
                username: msg.from.username || 'unknown'
            });
            updateStats('command', { command: '/start' });
            return handleStart(chatId);
        }

        switch(state) {
            case UserState.WAITING_FOR_GENDER:
                // Обрабатываем только callback, поэтому просто игнорируем текст
                break;

            case UserState.WAITING_FOR_NAME:
                return handleNameInput(chatId, text);

            case UserState.WAITING_FOR_BIRTHDATE:
                return handleBirthdateInput(chatId, text);

            default:
                // Для всех остальных состояний
                if (!text.startsWith('/')) {
                    bot.sendMessage(chatId, 'Я не понимаю. Напиши /start, чтобы начать.');
                }
        }
    } catch (error) {
        console.error('Ошибка обработки сообщения:', error);
        bot.sendMessage(chatId, 'Произошла ошибка. Попробуйте ещё раз.');
    }
});

bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const state = userStates.get(chatId) || UserState.START;

  try {
    switch(state) {
      case UserState.WAITING_FOR_GENDER:
        return handleGenderSelection(chatId, data);
      case UserState.CONFIRM_NAME:
        return handleNameConfirmation(chatId, data);
      case UserState.CONFIRM_BIRTHDATE:
        return handleBirthdateConfirmation(chatId, data);
      case UserState.WAITING_FOR_MORE:
        return handleMoreInfoRequest(chatId, data);
    }
    // Обработка кликов по ссылкам
        if (data === 'link_zazina') {
          updateStats('link_click', { linkName: 'ZAZINA_TATYANA' });
        } else if (data === 'link_channel') {
          updateStats('link_click', { linkName: 'Zazina_TD' });
        }
  } catch (error) {
    console.error('Ошибка обработки callback:', error);
    bot.sendMessage(chatId, 'Произошла ошибка. Попробуйте ещё раз.');
  }
});

function handleGenderSelection(chatId, gender) {
    storeUserData(chatId, 'gender', gender);
    userStates.set(chatId, UserState.WAITING_FOR_NAME);
    bot.sendMessage(chatId, 'Как тебя зовут?');
}

function handleNameInput(chatId, name) {
    if (isValidName(name)) {
        storeUserData(chatId, 'name', name);
        userStates.set(chatId, UserState.CONFIRM_NAME);

        const keyboard = {
            inline_keyboard: [
                [
                    { text: 'Да', callback_data: 'confirm_yes' },
                    { text: 'Нет', callback_data: 'confirm_no' }
                ]
            ]
        };

        bot.sendMessage(chatId, `Твое имя: ${name}?`, {
            reply_markup: keyboard
        });
    } else {
        bot.sendMessage(chatId, 'Пожалуйста, введи корректное имя (только буквы, 2-50 символов).');
    }
}

function handleNameConfirmation(chatId, confirmation) {
    if (confirmation === 'confirm_yes') {
        const gender = getUserData(chatId, 'gender');
        userStates.set(chatId, UserState.WAITING_FOR_BIRTHDATE);
        bot.sendMessage(chatId,
            gender === 'gender_male'
                ? 'Отлично! Когда ты родился? (ДД.ММ.ГГГГ)'
                : 'Отлично! Когда ты родилась? (ДД.ММ.ГГГГ)');
    } else {
        userStates.set(chatId, UserState.WAITING_FOR_NAME);
        bot.sendMessage(chatId, 'Хорошо, попробуем ещё раз. Как тебя зовут?');
    }
}

function handleBirthdateInput(chatId, birthDate) {
    if (birthDate.match(/^\d{2}\.\d{2}\.\d{4}$/)) {
        storeUserData(chatId, 'birthdate', birthDate);
        userStates.set(chatId, UserState.CONFIRM_BIRTHDATE);

        const gender = getUserData(chatId, 'gender');
        const keyboard = {
            inline_keyboard: [
                [
                    { text: 'Да', callback_data: 'confirm_yes' },
                    { text: 'Нет', callback_data: 'confirm_no' }
                ]
            ]
        };

        bot.sendMessage(chatId,
            gender === 'gender_male'
                ? `Ты родился ${birthDate}?`
                : `Ты родилась ${birthDate}?`, {
            reply_markup: keyboard
        });
    } else {
        bot.sendMessage(chatId, 'Пожалуйста, введи дату в формате ДД.ММ.ГГГГ.');
    }
}

function handleBirthdateConfirmation(chatId, confirmation) {
    if (confirmation === 'confirm_yes') {
        const birthDate = getUserData(chatId, 'birthdate');

        // 1. Сначала отправляем файл
        sendArcanumDocument(chatId, birthDate, () => {
            // 2. Это колбэк, который выполнится ПОСЛЕ успешной отправки файла
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: 'Да', callback_data: 'confirm_yes' },
                        { text: 'Нет', callback_data: 'confirm_no' }
                    ]
                ]
            };

            // 3. Затем отправляем сообщение с кнопками
            bot.sendMessage(chatId, 'Хотите узнать больше о своем аркане?', {
                reply_markup: keyboard
            });

            userStates.set(chatId, UserState.WAITING_FOR_MORE);
        });

    } else {
        userStates.set(chatId, UserState.WAITING_FOR_BIRTHDATE);
        bot.sendMessage(chatId, 'Хорошо, попробуем ещё раз. Введи дату в формате ДД.ММ.ГГГГ');
    }
}
function handleMoreInfoRequest(chatId, confirmation) {
    if (confirmation === 'confirm_yes') {
        const message = `🌟 Открой новые горизонты своей жизни с моими разборами!

📅 Персональный прогноз на год
Представь, что ты держишь в руках карту сокровищ, где каждый месяц твоего года раскрывает свои тайны. Этот прогноз — твой компас в океане возможностей.

✨ Что ты получишь:
- Характеристику каждого месяца
- Прогноз по ключевым сферам: деньги, отношения, здоровье
- Персональные рекомендации на каждый день

🌙 Прогноз на месяц
Это не просто предсказание, а практическое руководство к действию.

📆 Узнай энергию каждого дня, чтобы:
- Выбирать идеальное время для важных встреч
- Начинать проекты с максимальной эффективностью
- Восстанавливать силы в нужный момент

🗺 Дорожная карта
Представь панораму своей жизни как осмысленное путешествие души.

✨ Что входит:
- Детальная карта жизненного пути
- Инструмент для квантового скачка в ключевых сферах
- Чёткий план на ближайший год, 5 лет, 10 лет и дальше

🌌 Полное описание звезды
Комплексный анализ твоей жизни, включая глубинные структуры души и кармические задачи.

✨ Узнай:
- Своё предназначение
- Сильные стороны и зоны роста
- Как реализовать свой потенциал

👶 Разбор детской матрицы
Волшебный ключ к пониманию внутреннего мира твоего ребёнка.

✨ Создай среду, где:
- Таланты малыша расцветают
- Сложности превращаются в сильные стороны

🏛 Родовой квадрат
Уникальный инструмент для понимания и трансформации родовых программ.

✨ Осознай:
- Какие программы ты несёшь в себе
- Как они влияют на твою жизнь

🔑 Код успеха
Твой личный ключ к достижению целей.

✨ Активируй:
- Свои сильные стороны и скрытые таланты
- Путь наименьшего сопротивления к успеху

💼 Реализация
Раскрой законы своего личного денежного потока.

✨ Узнай:
- В каких сферах деятельности ты можешь раскрыть свой потенциал
- Как достичь финансового успеха и глубокого удовлетворения от работы

Для подробной консультации напишите мне лично https://t.me/ZAZINA\\_TATYANA

За прогнозом на каждый день переходи в мой канал 💛 - https://t.me/Zazina\\_TD`;

        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } else {
        bot.sendMessage(chatId,
            'Если передумаешь, пиши за разбором мне лично - https://t.me/ZAZINA_TATYANA \nХорошего дня! 😊');
    }
}
// Вспомогательные функции

function handleStart(chatId) {
    // Если уже в процессе диалога - не показываем приветствие снова
    if (userStates.get(chatId) && userStates.get(chatId) !== UserState.START) {
        return;
    }

    userStates.set(chatId, UserState.WAITING_FOR_GENDER);

    const keyboard = {
        inline_keyboard: [
            [
                { text: 'Мужчина', callback_data: 'gender_male' },
                { text: 'Девушка', callback_data: 'gender_female' }
            ]
        ]
    };

    bot.sendMessage(chatId, 'Привет! Ты девушка или мужчина?', {
        reply_markup: keyboard
    });
}

async function updateUserStats(chatId, user) {
    updateStats('new_user', {
        chatId,
        username: user.username || 'unknown'
    });
    updateStats('command', { command: '/start' });
}

async function sendArcanumDocument(chatId, birthDate, callback) {
    try {
        const day = parseInt(birthDate.split('.')[0]);
        const arcanumNumber = calculateArcanumNumber(day);
        const gender = getUserData(chatId, 'gender');
        const pdfPath = findArcanumPdf(arcanumNumber, gender);

        // Обновляем статистику
            updateStats('arcana', { arcanumNumber });
            updateStats('arcana_sent', { arcanumNumber, chatId });

            if (fs.existsSync(pdfPath)) {
              await bot.sendDocument(chatId, pdfPath, {
                caption: `Ваш аркан дня рождения: ${arcanumNumber}`,
                contentType: mime.lookup(pdfPath) || 'application/pdf', // Автоопределение типа
                filename: `arcanum_${arcanumNumber}.pdf`
              });
            } else {
              await bot.sendMessage(chatId, 'Извините, файл с описанием аркана не найден.');
            }
            callback();
          } catch (error) {
            console.error(error);
            await bot.sendMessage(chatId, 'Произошла ошибка при обработке вашей даты.');
            callback();
          }
        }

// Команда для администратора
bot.onText(/\/stats/, (msg) => {
  if (msg.chat.id.toString() !== ADMIN_ID) {
    return bot.sendMessage(msg.chat.id, 'Эта команда доступна только администратору');
  }

  try {
    const stats = JSON.parse(fs.readFileSync(STATS_FILE));
    let message = `📊 Статистика бота:
👥 Всего пользователей: ${stats.totalUsers}
🔮 Запросов арканов: ${Object.values(stats.arcanaRequests).reduce((a, b) => a + b, 0)}
🔗 Переходы по ссылкам:
   • ZAZINA_TATYANA: ${stats.linkClicks.ZAZINA_TATYANA}
   • Zazina_TD: ${stats.linkClicks.Zazina_TD}
📊 Популярные команды: ${JSON.stringify(stats.commandUsage)}`;

    // Добавляем детализацию по арканам
    message += `\n\n📦 Отправлено арканов:`;
    Object.entries(stats.arcanaSent || {}).forEach(([arcanum, data]) => {
      message += `\n• Аркан ${arcanum}: ${data.count} раз (${data.users.length} пользователей)`;
    });

    bot.sendMessage(msg.chat.id, message);
  } catch (err) {
    console.error('Ошибка получения статистики:', err);
    bot.sendMessage(msg.chat.id, 'Не удалось получить статистику');
  }
});

function calculateArcanumNumber(day) {
    if (day <= 22) return day;

    let sum = day.toString().split('').reduce((acc, digit) => acc + parseInt(digit), 0);
    while (sum > 22) {
        sum = sum.toString().split('').reduce((acc, digit) => acc + parseInt(digit), 0);
    }
    return sum;
}

function findArcanumPdf(arcanumNumber, gender) {
    const genderPrefix = gender === 'gender_male' ? 'm_' : 'f_';
    let pdfPath = `${PDF_BASE_PATH}${genderPrefix}arcanum_${arcanumNumber}.pdf`;

    if (fs.existsSync(pdfPath)) return pdfPath;

    pdfPath = `${PDF_BASE_PATH}arcanum_${arcanumNumber}.pdf`;
    if (fs.existsSync(pdfPath)) return pdfPath;

    return `${PDF_BASE_PATH}default.pdf`;
}

function storeUserData(chatId, key, value) {
    if (!userData.has(chatId)) {
        userData.set(chatId, {});
    }
    userData.get(chatId)[key] = value;
}

function getUserData(chatId, key) {
    return userData.get(chatId)?.[key];
}

function isValidName(name) {
    return /^[A-Za-zА-Яа-яёЁ]{2,50}$/.test(name);
}

// Запуск бота
if (isRailway) {
  console.log('🤖 Бот работает через Webhook на Railway');
} else {
  // Для локальной разработки можно временно включить polling
  console.log('🔧 Локальный режим разработки');
  bot.startPolling({
    restart: true,
    polling: {
      interval: 300,
      autoStart: true,
      params: {
        timeout: 10
      }
    }
  });

  bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
  });
}