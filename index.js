import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import pg from 'pg';
const { Pool } = pg;
import fs from 'fs';
import express from 'express';

dotenv.config();

// Проверка среды выполнения (добавьте эту строку)
const isRailway = process.env.RAILWAY_ENVIRONMENT === 'production';

console.log('Токен из token.env:', process.env.TELEGRAM_BOT_TOKEN);

// Константы
const PDF_BASE_PATH = './pdfs/';
const ADMIN_ID = process.env.ADMIN_ID || '199775458';

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

// Инициализация бота
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('Токен бота не найден!');

const bot = new TelegramBot(token, {
  polling: !isRailway // Polling только локально
});

// Настройка webhook для Railway
if (isRailway) {
  const app = express();
  const PORT = process.env.PORT || 3000;
  const domain = process.env.RAILWAY_STATIC_URL;

  app.use(express.json());

  app.post(`/webhook`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });

  bot.setWebHook(`https://${domain}/webhook`)
    .then(() => console.log('Webhook установлен на Railway'))
    .catch(console.error);

  app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
  });
}

// Инициализация PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL.replace(
        'postgres.railway.internal',
        'monorail.proxy.rlwy.net' // Заменяем на реальный хост
    ),
    ssl: { rejectUnauthorized: false }
});

// Создание таблиц при старте
(async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                chat_id BIGINT PRIMARY KEY,
                username TEXT,
                first_name TEXT,
                last_name TEXT,
                gender TEXT,
                name TEXT,
                birth_date TEXT,
                start_count INTEGER DEFAULT 0,
                last_start TIMESTAMP,
                arcs INTEGER[]
            );

            CREATE TABLE IF NOT EXISTS arcs_stats (
                arc_number INTEGER PRIMARY KEY,
                request_count INTEGER DEFAULT 0,
                last_request TIMESTAMP
            );
        `);
        console.log('База данных готова');
    } catch (err) {
        console.error('Ошибка инициализации БД:', err);
    }
})();

// Хранилища данных
const userStates = new Map();
const userData = new Map();

// Функции для работы с БД
async function updateUserStats(chatId, userInfo) {
    try {
        await pool.query(`
            INSERT INTO users (chat_id, username, first_name, last_name, start_count, last_start)
            VALUES ($1, $2, $3, $4, 1, NOW())
            ON CONFLICT (chat_id) DO UPDATE SET
                start_count = users.start_count + 1,
                last_start = NOW(),
                username = EXCLUDED.username,
                first_name = EXCLUDED.first_name,
                last_name = EXCLUDED.last_name
        `, [
            chatId,
            userInfo.username || 'unknown',
            userInfo.first_name || '',
            userInfo.last_name || ''
        ]);
    } catch (err) {
        console.error('Ошибка обновления статистики пользователя:', err);
    }
}

async function updateArcStats(arcanumNumber) {
    try {
        await pool.query(`
            INSERT INTO arcs_stats (arc_number, request_count, last_request)
            VALUES ($1, 1, NOW())
            ON CONFLICT (arc_number) DO UPDATE SET
                request_count = arcs_stats.request_count + 1,
                last_request = NOW()
        `, [arcanumNumber]);
    } catch (err) {
        console.error('Ошибка обновления статистики аркана:', err);
    }
}

// Обработчики сообщений
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (text === '/start') {
        await updateUserStats(chatId, msg.from);
        handleStart(chatId);
    } else {
        const state = userStates.get(chatId) || UserState.START;

        if (state === UserState.WAITING_FOR_NAME) {
            handleNameInput(chatId, text);
        } else if (state === UserState.WAITING_FOR_BIRTHDATE) {
            handleBirthdateInput(chatId, text);
        } else {
            bot.sendMessage(chatId, 'Я не понимаю. Напиши /start, чтобы начать.');
        }
    }
});

bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const state = userStates.get(chatId) || UserState.START;

    if (state === UserState.WAITING_FOR_GENDER) {
        handleGenderSelection(chatId, data);
    } else if (state === UserState.CONFIRM_NAME) {
        handleNameConfirmation(chatId, data);
    } else if (state === UserState.CONFIRM_BIRTHDATE) {
        handleBirthdateConfirmation(chatId, data);
    } else if (state === UserState.WAITING_FOR_MORE) {
        handleMoreInfoRequest(chatId, data);
    }
});

// Модифицированные обработчики
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (text === '/start') {
        await updateUserStats(chatId, msg.from);
        handleStart(chatId);
    } else {
        const state = userStates.get(chatId) || UserState.START;

        if (state === UserState.WAITING_FOR_NAME) {
            handleNameInput(chatId, text);
        } else if (state === UserState.WAITING_FOR_BIRTHDATE) {
            handleBirthdateInput(chatId, text);
        } else {
            bot.sendMessage(chatId, 'Я не понимаю. Напиши /start, чтобы начать.');
        }
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
async function sendArcanumDocument(chatId, birthDate, callback) {
    try {
        const day = parseInt(birthDate.split('.')[0]);
        const arcanumNumber = calculateArcanumNumber(day);
        const gender = getUserData(chatId, 'gender');
        const pdfPath = findArcanumPdf(arcanumNumber, gender);

        // Обновляем статистику
                await pool.query(`
                    UPDATE users
                    SET arcs = ARRAY_APPEND(COALESCE(arcs, '{}'::INTEGER[]), $1),
                        gender = $2,
                        name = $3,
                        birth_date = $4
                    WHERE chat_id = $5
                `, [
                    arcanumNumber,
                    gender,
                    getUserData(chatId, 'name'),
                    birthDate,
                    chatId
                ]);

        await updateArcStats(arcanumNumber);

        if (fs.existsSync(pdfPath)) {
            bot.sendDocument(chatId, pdfPath, {
                caption: `Ваш аркан дня рождения: ${arcanumNumber}`
            }).then(() => {
                callback(); // Вызываем колбэк после успешной отправки
            });
        } else {
            bot.sendMessage(chatId, 'Извините, файл с описанием аркана не найден.');
            callback(); // Все равно вызываем колбэк
        }
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, 'Произошла ошибка при обработке вашей даты.');
        callback(); // Все равно вызываем колбэк
    }
}

// Новая функция для получения статистики
async function getBotStats() {
    try {
        const res = await pool.query(`
            SELECT
                (SELECT COUNT(*) FROM users) as total_users,
                (SELECT SUM(start_count) FROM users) as total_starts,
                (SELECT COUNT(*) FROM arcs_stats) as unique_arcs,
                (SELECT SUM(request_count) FROM arcs_stats) as total_arc_requests
        `);
        return res.rows[0];
    } catch (err) {
        console.error('Ошибка получения статистики:', err);
        return null;
    }
}

// Команда для администратора
bot.onText(/\/stats/, async (msg) => {
    if (msg.chat.id.toString() !== process.env.ADMIN_ID) {
        return bot.sendMessage(msg.chat.id, 'Эта команда доступна только администратору');
    }

    try {
        const stats = await getBotStats();
        if (!stats) {
            return bot.sendMessage(msg.chat.id, 'Не удалось получить статистику');
        }

        const message = `📊 Статистика бота:
👥 Всего пользователей: ${stats.total_users}
🚀 Всего запусков: ${stats.total_starts}
🔮 Уникальных арканов: ${stats.unique_arcs}
📨 Запросов арканов: ${stats.total_arc_requests}`;

        bot.sendMessage(msg.chat.id, message);
    } catch (err) {
        console.error('Ошибка обработки команды /stats:', err);
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
if (!process.env.RAILWAY_ENV) {
    bot.on('polling_error', (error) => {
        console.error('Polling error:', error);
    });
    console.log('Бот запущен в режиме polling');
} else {
    console.log('Бот готов к работе через webhook');
}
console.log(
  isRailway
    ? 'Бот запущен в режиме production (Railway)'
    : 'Бот запущен в режиме разработки (polling)'
);