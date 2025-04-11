import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import express from 'express';
import mime from 'mime-types';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import ipRangeCheck from 'ip-range-check';

// 1. Инициализация Express
const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);
app.use(express.json());

// 2. Загрузка конфигурации
dotenv.config();

// 3. Проверка переменных окружения
const requiredEnvVars = [
  'TELEGRAM_BOT_TOKEN',
  'ADMIN_ID',
  'ADMIN_PASSWORD',
  'WEBHOOK_SECRET',
  'SECRET_KEY',
  'IV'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Ошибка: Необходимо установить переменную ${envVar} в .env`);
    process.exit(1);
  }
}

// 4. Настройка middleware
app.use(express.json());
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: '⚠️ Слишком много запросов',
  validate: {
    trustProxy: true,
    xForwardedForHeader: true
  },
  keyGenerator: (req) => {
    return req.headers['x-real-ip'] || req.ip;
  }
});

const isRailway = process.env.RAILWAY_ENVIRONMENT === 'production';

// 3. Инициализируем бота
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: false });

// 4. Константы безопасности
const PDF_BASE_PATH = './pdfs/';
const STATS_FILE = path.join(process.cwd(), 'bot_stats.json');
const SECURITY_LOG = path.join(process.cwd(), 'security.log');
const TELEGRAM_IPS = ['149.154.160.0/20', '91.108.4.0/22'];
const MAX_PDF_SIZE = 5 * 1024 * 1024; // 5MB

app.use(express.json());
app.use('/webhook', limiter);

// 6. Проверка директорий
function ensureDirectoriesExist() {
  const dirs = [PDF_BASE_PATH, path.dirname(STATS_FILE)];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

ensureDirectoriesExist();

// 7. Шифрование статистики
function encryptData(data) {
  const cipher = crypto.createCipheriv(
    'aes-256-cbc',
    Buffer.from(process.env.SECRET_KEY, 'hex'), // Декодируем из hex
    Buffer.from(process.env.IV, 'hex')
  );
  return Buffer.concat([
    cipher.update(JSON.stringify(data)),
    cipher.final()
  ]).toString('hex');
}

// Модифицируем функцию decryptData для лучшего логирования
function decryptData(encrypted) {
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      Buffer.from(process.env.SECRET_KEY, 'hex'),
      Buffer.from(process.env.IV, 'hex')
    );

    const decryptedBuffer = Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'hex')),
      decipher.final()
    ]);

    return JSON.parse(decryptedBuffer.toString());
  } catch (err) {
    console.error('❌ Ошибка дешифровки:', err.stack);
    throw new Error('Неверные ключи шифрования или повреждённые данные');
  }
}

// 8. Логирование безопасности
function logSecurityEvent(event, chatId = null, details = '') {
  const logEntry = `[${new Date().toISOString()}] ${event} ${
    chatId ? `| ChatID: ${chatId} ` : ''
  }| ${details}\n`;

  fs.appendFileSync(SECURITY_LOG, logEntry, 'utf8');
}

// 9. Валидация данных
function sanitizeName(name) {
  return name.replace(/[^\p{L}\s-]/gu, '').trim();
}

function isValidDate(dateStr) {
  if (!/^\d{2}\.\d{2}\.\d{4}$/.test(dateStr)) return false;

  const [dd, mm, yyyy] = dateStr.split('.');
  const date = new Date(`${yyyy}-${mm}-${dd}`);

  return (
    !isNaN(date) &&
    date.getDate() === parseInt(dd) &&
    date.getMonth() + 1 === parseInt(mm)
  );
}

// 10. Защищенный обработчик webhook
app.post('/webhook', (req, res) => {
  try {
    // Проверка IP Telegram
    const clientIp = req.headers['x-forwarded-for'] || req.ip.replace('::ffff:', '');
    if (!ipRangeCheck(clientIp, TELEGRAM_IPS)) {
      logSecurityEvent('IP_BLOCKED', null, `IP: ${clientIp}`);
      return res.status(403).send('Forbidden');
    }

    // Проверка секретного токена
    if (req.headers['x-telegram-bot-api-secret-token'] !== process.env.WEBHOOK_SECRET) {
      logSecurityEvent('INVALID_WEBHOOK_TOKEN');
      return res.status(403).send('Forbidden');
    }

    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (error) {
    logSecurityEvent('WEBHOOK_ERROR', null, error.message);
    res.status(500).send('Internal Server Error');
  }
});

// Эндпоинт для расшифровки статистики (только для администратора)

app.get('/decrypt-stats', (req, res) => {
  try {
    // Проверка IP администратора
    const clientIp = req.headers['x-forwarded-for'] || req.ip.replace('::ffff:', '');
    if (clientIp !== process.env.ADMIN_IP) {
      logSecurityEvent('ADMIN_IP_BLOCKED', null, `IP: ${clientIp}`);
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Проверка наличия файла
    if (!fs.existsSync(STATS_FILE)) {
      return res.status(404).json({ error: 'Файл статистики не найден' });
    }

    // Чтение и расшифровка данных
    const encrypted = fs.readFileSync(STATS_FILE, 'utf8');
    const decrypted = decryptData(encrypted);

    res.json({
      status: 'success',
      data: decrypted
    });

  } catch (err) {
    logSecurityEvent('DECRYPT_ERROR', null, err.message);
    res.status(500).json({
      error: 'Ошибка расшифровки',
      details: err.message
    });
  }
});

// 11. Инициализация статистики
function initStats() {
  try {
    if (!fs.existsSync(STATS_FILE)) {
      console.log('🔄 Создаю новый файл статистики...');

      const defaultData = {
        totalUsers: 0,
        activeUsers: [],
        arcanaRequests: {},
        arcanaSent: {},
        linkClicks: {
          ZAZINA_TATYANA: 0,
          Zazina_TD: 0
        },
        commandUsage: {}
      };

      fs.writeFileSync(STATS_FILE, encryptData(defaultData));
      logSecurityEvent('STATS_INIT');
      console.log('✅ Файл статистики создан');
    }
  } catch (err) {
    console.error('❌ Ошибка создания файла:', err);
    process.exit(1);
  }
}



// 12. Обновление статистики с шифрованием
function updateStats(type, data) {
  try {
    initStats();

    const stats = decryptData(fs.readFileSync(STATS_FILE, 'utf8'));

    switch(type) {
      case 'new_user':
        if (stats.activeUsers.some(user => user.id === data.chatId)) {
          logSecurityEvent('DUPLICATE_USER', data.chatId);
          return;
        }
        stats.totalUsers += 1;
        stats.activeUsers.push({
          id: data.chatId,
          username: data.username,
          firstInteraction: new Date().toISOString()
        });
        break;

      case 'arcana':
        stats.arcanaRequests[data.arcanumNumber] =
          (stats.arcanaRequests[data.arcanumNumber] || 0) + 1;
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

    fs.writeFileSync(STATS_FILE, encryptData(stats));
      } catch (err) {
        logSecurityEvent('STATS_ERROR', null, err.message);
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

  bot.setWebHook(webhookUrl, {
    secret_token: process.env.WEBHOOK_SECRET
  })
    .then(() => console.log(`✅ Webhook установлен на ${webhookUrl}`))
    .catch(err => {
      console.error('❌ Ошибка webhook:', err);
      process.exit(1);
    });
}

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

// 13. Защищенная отправка PDF
async function sendArcanumDocument(chatId, birthDate, callback) {
  try {
    const day = parseInt(birthDate.split('.')[0]);
    const arcanumNumber = calculateArcanumNumber(day);
    const gender = getUserData(chatId, 'gender');
    const pdfPath = findArcanumPdf(arcanumNumber, gender);

    if (!fs.existsSync(pdfPath)) {
      throw new Error('PDF not found');
    }

    // Проверка размера файла
    const stats = fs.statSync(pdfPath);
    if (stats.size > MAX_PDF_SIZE) {
      logSecurityEvent('PDF_SIZE_EXCEEDED', chatId, `Size: ${stats.size}`);
      throw new Error('PDF file too large');
    }

    updateStats('arcana', { arcanumNumber });
    updateStats('arcana_sent', { arcanumNumber, chatId });

    await bot.sendDocument(chatId, pdfPath, {
      caption: `Ваш аркан дня рождения: ${arcanumNumber}`,
      contentType: mime.lookup(pdfPath) || 'application/pdf',
      filename: `arcanum_${arcanumNumber}.pdf`
    });

    callback();
  } catch (error) {
    logSecurityEvent('PDF_SEND_ERROR', chatId, error.message);
    console.error(error);
    await bot.sendMessage(chatId, 'Произошла ошибка при отправке файла.');
    callback(error);
  }
}

// 14. Защищенные команды администратора
bot.onText(/\/stats (.+)/, (msg, match) => {
  const chatId = msg.chat.id.toString();
  const password = match[1];

  if (chatId !== process.env.ADMIN_ID || password !== process.env.ADMIN_PASSWORD) {
    logSecurityEvent('ADMIN_ACCESS_DENIED', chatId);
    return bot.sendMessage(chatId, 'Доступ запрещен.');
  }

  try {
    const stats = decryptData(fs.readFileSync(STATS_FILE, 'utf8'));
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

    bot.sendMessage(chatId, message);
      } catch (err) {
        logSecurityEvent('ADMIN_STATS_ERROR', chatId, err.message);
        bot.sendMessage(chatId, 'Не удалось получить статистику');
      }
    });
    // 15. Основной обработчик сообщений с проверкой безопасности
    bot.on('message', async (msg) => {
      const chatId = msg.chat.id;
      const text = msg.text || '';

      // Проверка на приватный чат
      if (msg.chat.type !== 'private') {
        logSecurityEvent('NON_PRIVATE_CHAT', chatId);
        return bot.sendMessage(chatId, 'Извините, я работаю только в личных чатах.');
      }

      // Защита от слишком длинных сообщений
      if (text.length > 100) {
        logSecurityEvent('LONG_MESSAGE', chatId, `Length: ${text.length}`);
        return bot.sendMessage(chatId, 'Сообщение слишком длинное. Максимум 100 символов.');
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

// Запуск сервера и бота
app.listen(PORT, async () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  logSecurityEvent('SERVER_START', null, `Port: ${PORT}`);

  try {
    if (isRailway) {
      console.log('🤖 Режим Webhook');
    } else {
      console.log('🔧 Локальный режим разработки');
      await bot.deleteWebHook();
      bot.startPolling();
    }
  } catch (error) {
    console.error('❌ Ошибка инициализации бота:', error);
    process.exit(1);
  }
});

  bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
  });