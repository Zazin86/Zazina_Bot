package Tutorial;

import org.telegram.telegrambots.bots.TelegramLongPollingBot;
import org.telegram.telegrambots.meta.api.methods.send.SendMessage;
import org.telegram.telegrambots.meta.api.methods.send.SendDocument;
import org.telegram.telegrambots.meta.api.objects.InputFile;
import org.telegram.telegrambots.meta.api.objects.Update;
import org.telegram.telegrambots.meta.api.objects.replykeyboard.InlineKeyboardMarkup;
import org.telegram.telegrambots.meta.api.objects.replykeyboard.buttons.InlineKeyboardButton;
import org.telegram.telegrambots.meta.exceptions.TelegramApiException;
import org.telegram.telegrambots.meta.TelegramBotsApi;
import org.telegram.telegrambots.updatesreceivers.DefaultBotSession;
import io.github.cdimascio.dotenv.Dotenv;

import java.io.File;
import java.util.*;

public class Tutorial extends TelegramLongPollingBot {

    // Перечисление состояний диалога с пользователем
    private enum UserState {
        START,                  // Начальное состояние при команде /start
        WAITING_FOR_GENDER,      // Ожидание выбора пола
        WAITING_FOR_NAME,        // Ожидание ввода имени
        CONFIRM_NAME,            // Подтверждение имени
        WAITING_FOR_BIRTHDATE,   // Ожидание ввода даты рождения
        CONFIRM_BIRTHDATE,       // Подтверждение даты рождения
        WAITING_FOR_MORE         // Предложение дополнительной информации
    }

    // Хранилище состояний пользователей (ключ - chatId)
    private Map<Long, UserState> userStates = new HashMap<>();

    // Хранилище данных пользователей (имя, пол, дата рождения)
    private Map<Long, Map<String, String>> userData = new HashMap<>();

    // Базовый путь к папке с PDF файлами арканов
    private static final String PDF_BASE_PATH = "C:\\Users\\User\\IdeaProjects\\Zazin_Bot\\pdfs\\";

    /**
     * Основной метод обработки входящих обновлений от Telegram
     * @param update Входящее обновление (сообщение или callback)
     */
    @Override
    public void onUpdateReceived(Update update) {
        // Если получено текстовое сообщение
        if (update.hasMessage() && update.getMessage().hasText()) {
            handleTextMessage(update);
        }
        // Если получен callback от нажатия кнопки
        else if (update.hasCallbackQuery()) {
            handleCallbackQuery(update);
        }
    }

    /**
     * Обработка текстовых сообщений от пользователя
     * @param update Объект входящего сообщения
     */
    private void handleTextMessage(Update update) {
        String messageText = update.getMessage().getText();
        long chatId = update.getMessage().getChatId();

        // Создаем объект для ответного сообщения
        SendMessage message = new SendMessage();
        message.setChatId(String.valueOf(chatId));

        // Получаем текущее состояние пользователя
        UserState userState = userStates.getOrDefault(chatId, UserState.START);

        // Обработка команды /start - начало диалога
        if (messageText.equalsIgnoreCase("/start")) {
            message.setText("Привет! Ты мужчина или девушка?");
            message.setReplyMarkup(createGenderKeyboard()); // Добавляем кнопки выбора пола
            userStates.put(chatId, UserState.WAITING_FOR_GENDER);
        }
        // Обработка ввода имени
        else if (userState == UserState.WAITING_FOR_NAME) {
            handleNameInput(chatId, messageText, message);
        }
        // Обработка ввода даты рождения
        else if (userState == UserState.WAITING_FOR_BIRTHDATE) {
            handleBirthdateInput(chatId, messageText, message);
        }
        // Неизвестная команда/сообщение
        else {
            message.setText("Я не понимаю. Напиши /start, чтобы начать.");
        }

        // Отправляем сформированный ответ
        try {
            execute(message);
        } catch (TelegramApiException e) {
            e.printStackTrace();
        }
    }

    /**
     * Обработка ввода имени пользователя
     * @param chatId ID чата
     * @param name Введенное имя
     * @param message Объект сообщения для ответа
     */
    private void handleNameInput(long chatId, String name, SendMessage message) {
        if (isValidName(name)) {
            // Сохраняем имя и запрашиваем подтверждение
            storeUserData(chatId, "name", name);
            message.setText("Твое имя: " + name + "?");
            message.setReplyMarkup(createConfirmationKeyboard());
            userStates.put(chatId, UserState.CONFIRM_NAME);
        } else {
            message.setText("Пожалуйста, введи корректное имя (только буквы, 2-50 символов).");
        }
    }

    /**
     * Обработка ввода даты рождения
     * @param chatId ID чата
     * @param birthDate Введенная дата рождения
     * @param message Объект сообщения для ответа
     */
    private void handleBirthdateInput(long chatId, String birthDate, SendMessage message) {
        // Проверяем формат даты (ДД.ММ.ГГГГ)
        if (birthDate.matches("\\d{2}\\.\\d{2}\\.\\d{4}")) {
            storeUserData(chatId, "birthdate", birthDate);
            String gender = getUserData(chatId, "gender");
            // Формируем вопрос с учетом пола
            message.setText(gender.equals("gender_male")
                    ? "Ты родился " + birthDate + "?"
                    : "Ты родилась " + birthDate + "?");
            message.setReplyMarkup(createConfirmationKeyboard());
            userStates.put(chatId, UserState.CONFIRM_BIRTHDATE);
        } else {
            message.setText("Пожалуйста, введи дату в формате ДД.ММ.ГГГГ.");
        }
    }

    /**
     * Обработка нажатий на inline-кнопки
     * @param update Объект callback-запроса
     */
    private void handleCallbackQuery(Update update) {
        String callbackData = update.getCallbackQuery().getData();
        long chatId = update.getCallbackQuery().getMessage().getChatId();

        SendMessage message = new SendMessage();
        message.setChatId(String.valueOf(chatId));

        // Получаем текущее состояние пользователя
        UserState userState = userStates.getOrDefault(chatId, UserState.START);

        // Обработка в зависимости от состояния
        switch (userState) {
            case WAITING_FOR_GENDER:
                handleGenderSelection(chatId, callbackData, message);
                break;
            case CONFIRM_NAME:
                handleNameConfirmation(chatId, callbackData, message);
                break;
            case CONFIRM_BIRTHDATE:
                handleBirthdateConfirmation(chatId, callbackData, message);
                break;
            case WAITING_FOR_MORE:
                handleMoreInfoRequest(chatId, callbackData, message);
                break;
        }

        // Отправляем ответ если он был сформирован
        try {
            if (message.getText() != null) {
                execute(message);
            }
        } catch (TelegramApiException e) {
            e.printStackTrace();
        }
    }

    /**
     * Обработка выбора пола
     * @param chatId ID чата
     * @param gender Выбранный пол ("gender_male" или "gender_female")
     * @param message Объект сообщения для ответа
     */
    private void handleGenderSelection(long chatId, String gender, SendMessage message) {
        storeUserData(chatId, "gender", gender);
        message.setText("Как тебя зовут?");
        userStates.put(chatId, UserState.WAITING_FOR_NAME);
    }

    /**
     * Обработка подтверждения имени
     * @param chatId ID чата
     * @param confirmation Результат подтверждения ("confirm_yes" или "confirm_no")
     * @param message Объект сообщения для ответа
     */
    private void handleNameConfirmation(long chatId, String confirmation, SendMessage message) {
        if (confirmation.equals("confirm_yes")) {
            String gender = getUserData(chatId, "gender");
            message.setText(gender.equals("gender_male")
                    ? "Отлично! Когда ты родился? (ДД.ММ.ГГГГ)"
                    : "Отлично! Когда ты родилась? (ДД.ММ.ГГГГ)");
            userStates.put(chatId, UserState.WAITING_FOR_BIRTHDATE);
        } else {
            message.setText("Хорошо, попробуем ещё раз. Как тебя зовут?");
            userStates.put(chatId, UserState.WAITING_FOR_NAME);
        }
    }

    /**
     * Обработка подтверждения даты рождения и отправка соответствующего аркана
     * @param chatId ID чата
     * @param confirmation Результат подтверждения
     * @param message Объект сообщения для ответа
     */
    private void handleBirthdateConfirmation(long chatId, String confirmation, SendMessage message) {
        if (confirmation.equals("confirm_yes")) {
            String birthDate = getUserData(chatId, "birthdate");
            // Отправляем PDF с арканом
            sendArcanumDocument(chatId, birthDate);

            message.setText("Хотите узнать больше о своем аркане?");
            message.setReplyMarkup(createConfirmationKeyboard());
            userStates.put(chatId, UserState.WAITING_FOR_MORE);
        } else {
            message.setText("Хорошо, попробуем ещё раз. Введи дату в формате ДД.ММ.ГГГГ");
            userStates.put(chatId, UserState.WAITING_FOR_BIRTHDATE);
        }
    }

    /**
     * Обработка запроса дополнительной информации
     * @param chatId ID чата
     * @param confirmation Результат подтверждения
     * @param message Объект сообщения для ответа
     */
    private void handleMoreInfoRequest(long chatId, String confirmation, SendMessage message) {
        if (confirmation.equals("confirm_yes")) {
            try {
                // Первое сообщение с описанием услуг
                SendMessage contactMessage = new SendMessage();
                contactMessage.setChatId(String.valueOf(chatId));
                contactMessage.setText("🌟 Открой новые горизонты своей жизни с моими разборами! \n\n" +
                        "📅 Персональный прогноз на год\n" +
                        "Представь, что ты держишь в руках карту сокровищ, где каждый месяц твоего года раскрывает свои тайны. Этот прогноз — твой компас в океане возможностей.\n\n" +
                        "✨ Что ты получишь:\n" +
                        "- Характеристику каждого месяца\n" +
                        "- Прогноз по ключевым сферам: деньги, отношения, здоровье\n" +
                        "- Персональные рекомендации на каждый день\n\n" +
                        "Это твой шанс принимать верные решения и жить в гармонии с энергиями Вселенной.\n\n" +
                        "🌙 Прогноз на месяц\n" +
                        "Это не просто предсказание, а практическое руководство к действию.\n\n" +
                        "📆 Узнай энергию каждого дня, чтобы:\n" +
                        "- Выбирать идеальное время для важных встреч\n" +
                        "- Начинать проекты с максимальной эффективностью\n" +
                        "- Восстанавливать силы в нужный момент\n\n" +
                        "🗺 Дорожная карта\n" +
                        "Представь панораму своей жизни как осмысленное путешествие души.\n\n" +
                        "✨ Что входит:\n" +
                        "- Детальная карта жизненного пути\n" +
                        "- Инструмент для квантового скачка в ключевых сферах\n" +
                        "- Чёткий план на ближайший год, 5 лет, 10 лет и дальше\n\n" +
                        "Это твой путеводитель к осознанной и гармоничной жизни.\n\n" +
                        "🌌 Полное описание звезды\n" +
                        "Комплексный анализ твоей жизни, включая глубинные структуры души и кармические задачи.\n\n" +
                        "✨ Узнай:\n" +
                        "- Своё предназначение\n" +
                        "- Сильные стороны и зоны роста\n" +
                        "- Как реализовать свой потенциал\n\n" +
                        "👶 Разбор детской матрицы\n" +
                        "Волшебный ключ к пониманию внутреннего мира твоего ребёнка.\n\n" +
                        "✨ Создай среду, где:\n" +
                        "- Таланты малыша расцветают\n" +
                        "- Сложности превращаются в сильные стороны\n\n" +
                        "Это бесценный инструмент для осознанного родительства.\n\n" +
                        "🏛 Родовой квадрат\n" +
                        "Уникальный инструмент для понимания и трансформации родовых программ.\n\n" +
                        "✨ Осознай:\n" +
                        "- Какие программы ты несёшь в себе\n" +
                        "- Как они влияют на твою жизнь\n\n" +
                        "Получи свободу выбора и создай новую историю для себя и будущих поколений.\n\n" +
                        "🔑 Код успеха\n" +
                        "Твой личный ключ к достижению целей.\n\n" +
                        "✨ Активируй:\n" +
                        "- Свои сильные стороны и скрытые таланты\n" +
                        "- Путь наименьшего сопротивления к успеху\n\n" +
                        "Действуй в гармонии со своей истинной природой и достигай большего с меньшими усилиями.\n\n" +
                        "💼 Реализация\n" +
                        "Раскрой законы своего личного денежного потока.\n\n" +
                        "✨ Узнай:\n" +
                        "- В каких сферах деятельности ты можешь раскрыть свой потенциал\n" +
                        "- Как достичь финансового успеха и глубокого удовлетворения от работы\n\n" +
                        " За прогнозом на каждый день переходи в мой канал \uD83D\uDC9B  - https://t.me/Zazina_TD");
                execute(contactMessage);

                // Второе сообщение с контактом
                SendMessage servicesMessage = new SendMessage();
                servicesMessage.setChatId(String.valueOf(chatId));
                servicesMessage.setText("Для подробной консультации напишите мне @ZAZINA_TATYANA");

                execute(servicesMessage);
                return; // Важно: завершаем обработку здесь
            } catch (TelegramApiException e) {
                e.printStackTrace();
            }
        } else {
            message.setText("Если передумаешь, пиши за разбором мне лично - https://t.me/ZAZINA_TATYANA  \uD83D\uDE4C\n" +
                    "Хорошего дня! \uD83D\uDE0A");

        }
    }

    /**
     * Отправка PDF документа с арканом по дате рождения
     * @param chatId ID чата
     * @param birthDate Дата рождения в формате ДД.ММ.ГГГГ
     */
    private void sendArcanumDocument(long chatId, String birthDate) {
        try {
            // Разбиваем дату на составляющие
            String[] parts = birthDate.split("\\.");
            int day = Integer.parseInt(parts[0]); // Извлекаем день

            // Вычисляем номер аркана
            int arcanumNumber = calculateArcanumNumber(day);
            String gender = getUserData(chatId, "gender");

            // Находим соответствующий PDF файл
            String pdfPath = findArcanumPdf(arcanumNumber, gender);

            // Отправляем документ пользователю
            sendPdfDocument(chatId, pdfPath, "Ваш аркан дня рождения: " + arcanumNumber);

        } catch (Exception e) {
            e.printStackTrace();
            sendTextMessage(chatId, "Произошла ошибка при обработке вашей даты.");
        }
    }

    /**
     * Вычисление номера аркана по дню рождения
     * @param day День рождения (1-31)
     * @return Номер аркана (1-22)
     */
    private int calculateArcanumNumber(int day) {
        // Для дней 1-22 аркан соответствует числу
        if (day <= 22) {
            return day;
        }

        // Для дней 23-31 суммируем цифры
        int sum = 0;
        int tempDay = day;
        while (tempDay > 0) {
            sum += tempDay % 10;
            tempDay /= 10;
        }

        // Если сумма больше 22, продолжаем суммировать цифры
        while (sum > 22) {
            int newSum = 0;
            int tempSum = sum;
            while (tempSum > 0) {
                newSum += tempSum % 10;
                tempSum /= 10;
            }
            sum = newSum;
        }

        return sum;
    }

    /**
     * Поиск PDF файла аркана с учетом пола
     * @param arcanumNumber Номер аркана (1-22)
     * @param gender Пол пользователя
     * @return Путь к файлу PDF
     */
    private String findArcanumPdf(int arcanumNumber, String gender) {
        // Пробуем найти гендерно-специфичный файл (m_arcanum_X.pdf или f_arcanum_X.pdf)
        String genderPrefix = gender.equals("gender_male") ? "m_" : "f_";
        String pdfPath = PDF_BASE_PATH + genderPrefix + "arcanum_" + arcanumNumber + ".pdf";

        if (new File(pdfPath).exists()) {
            return pdfPath;
        }

        // Если гендерного файла нет, пробуем универсальный (arcanum_X.pdf)
        pdfPath = PDF_BASE_PATH + "arcanum_" + arcanumNumber + ".pdf";
        if (new File(pdfPath).exists()) {
            return pdfPath;
        }

        // Если файл аркана не найден, возвращаем файл по умолчанию
        return PDF_BASE_PATH + "default.pdf";
    }

    /**
     * Отправка PDF документа пользователю
     * @param chatId ID чата
     * @param filePath Путь к файлу PDF
     * @param caption Подпись к документу
     */
    private void sendPdfDocument(long chatId, String filePath, String caption) {
        try {
            File pdfFile = new File(filePath);
            if (!pdfFile.exists()) {
                sendTextMessage(chatId, "Извините, файл с описанием аркана не найден.");
                return;
            }

            // Создаем и настраиваем объект для отправки документа
            SendDocument sendDocument = new SendDocument();
            sendDocument.setChatId(String.valueOf(chatId));
            sendDocument.setDocument(new InputFile(pdfFile));
            sendDocument.setCaption(caption);

            // Отправляем документ
            execute(sendDocument);
        } catch (TelegramApiException e) {
            e.printStackTrace();
            sendTextMessage(chatId, "Ошибка при отправке файла.");
        }
    }

    /**
     * Отправка текстового сообщения
     * @param chatId ID чата
     * @param text Текст сообщения
     */
    private void sendTextMessage(long chatId, String text) {
        SendMessage message = new SendMessage();
        message.setChatId(String.valueOf(chatId));
        message.setText(text);
        try {
            execute(message);
        } catch (TelegramApiException e) {
            e.printStackTrace();
        }
    }

    /**
     * Сохранение данных пользователя
     * @param chatId ID чата
     * @param key Ключ данных (name, gender, birthdate)
     * @param value Значение
     */
    private void storeUserData(long chatId, String key, String value) {
        userData.computeIfAbsent(chatId, k -> new HashMap<>()).put(key, value);
    }

    /**
     * Получение сохраненных данных пользователя
     * @param chatId ID чата
     * @param key Ключ данных
     * @return Значение или null если не найдено
     */
    private String getUserData(long chatId, String key) {
        return userData.getOrDefault(chatId, Collections.emptyMap()).get(key);
    }

    /**
     * Создание клавиатуры для выбора пола
     * @return Объект InlineKeyboardMarkup с кнопками "Мужчина" и "Девушка"
     */
    private InlineKeyboardMarkup createGenderKeyboard() {
        InlineKeyboardMarkup keyboardMarkup = new InlineKeyboardMarkup();
        List<List<InlineKeyboardButton>> keyboard = new ArrayList<>();

        // Кнопка "Мужчина"
        InlineKeyboardButton maleButton = new InlineKeyboardButton();
        maleButton.setText("Мужчина");
        maleButton.setCallbackData("gender_male");

        // Кнопка "Девушка"
        InlineKeyboardButton femaleButton = new InlineKeyboardButton();
        femaleButton.setText("Девушка");
        femaleButton.setCallbackData("gender_female");

        // Добавляем кнопки в один ряд
        keyboard.add(Arrays.asList(maleButton, femaleButton));
        keyboardMarkup.setKeyboard(keyboard);
        return keyboardMarkup;
    }

    /**
     * Создание клавиатуры с кнопками подтверждения
     * @return Объект InlineKeyboardMarkup с кнопками "Да" и "Нет"
     */
    private InlineKeyboardMarkup createConfirmationKeyboard() {
        InlineKeyboardMarkup keyboardMarkup = new InlineKeyboardMarkup();
        List<List<InlineKeyboardButton>> keyboard = new ArrayList<>();

        // Кнопка "Да"
        InlineKeyboardButton yesButton = new InlineKeyboardButton();
        yesButton.setText("Да");
        yesButton.setCallbackData("confirm_yes");

        // Кнопка "Нет"
        InlineKeyboardButton noButton = new InlineKeyboardButton();
        noButton.setText("Нет");
        noButton.setCallbackData("confirm_no");

        // Добавляем кнопки в один ряд
        keyboard.add(Arrays.asList(yesButton, noButton));
        keyboardMarkup.setKeyboard(keyboard);
        return keyboardMarkup;
    }

    /**
     * Проверка валидности имени
     * @param name Проверяемое имя
     * @return true если имя валидно (только буквы, 2-50 символов)
     */
    private boolean isValidName(String name) {
        return name.matches("[A-Za-zА-Яа-яёЁ]+") && name.length() >= 2 && name.length() <= 50;
    }

    @Override
    public String getBotUsername() {
        return "ZazinaBot";
    }

    @Override
    public String getBotToken() {
        // Пробуем получить токен из переменных окружения (для продакшена)
        String token = System.getenv("TELEGRAM_BOT_TOKEN");

        // Если не найден, читаем из .env (для разработки)
        if (token == null) {
            Dotenv dotenv = Dotenv.load();
            token = dotenv.get("TELEGRAM_BOT_TOKEN");
        }

        if (token == null || token.isEmpty()) {
            throw new IllegalStateException("Токен бота не найден! Проверьте переменную TELEGRAM_BOT_TOKEN");
        }
        return token;
    }

    public static void main(String[] args) {
        try {
            // Регистрация и запуск бота
            TelegramBotsApi botsApi = new TelegramBotsApi(DefaultBotSession.class);
            botsApi.registerBot(new Tutorial());
        } catch (TelegramApiException e) {
            e.printStackTrace();
        }
    }
}