import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

console.log('Токен из token.env:', process.env.TELEGRAM_BOT_TOKEN);

// Константы
const PDF_BASE_PATH = './pdfs/';

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
if (!token) {
    throw new Error('Токен бота не найден! Проверьте переменную TELEGRAM_BOT_TOKEN');
}

const bot = new TelegramBot(token, { polling: true });

// Хранилища данных
const userStates = new Map();
const userData = new Map();

// Обработчики сообщений
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (text === '/start') {
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

// Функции обработки
function handleStart(chatId) {
    userStates.set(chatId, UserState.WAITING_FOR_GENDER);

    const keyboard = {
        inline_keyboard: [
            [
                { text: 'Мужчина', callback_data: 'gender_male' },
                { text: 'Девушка', callback_data: 'gender_female' }
            ]
        ]
    };

    bot.sendMessage(chatId, 'Привет! Ты мужчина или девушка?', {
        reply_markup: keyboard
    });
}

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
function sendArcanumDocument(chatId, birthDate, callback) {
    try {
        const day = parseInt(birthDate.split('.')[0]);
        const arcanumNumber = calculateArcanumNumber(day);
        const gender = getUserData(chatId, 'gender');
        const pdfPath = findArcanumPdf(arcanumNumber, gender);

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

console.log('Бот запущен!');