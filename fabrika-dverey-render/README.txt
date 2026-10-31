ФАБРИКА ДВЕРЕЙ: сайт + админка + заявки в Telegram (один Node-сервер, без зависимостей)

Структура
  server.js          сервер: сайт, админка, API, отправка заявок в Telegram
  public/index.html  сайт
  public/admin/      админка (адрес /admin/)
  data/catalog.json  создаётся сам, здесь хранятся двери и категории
  data/uploads/      фото дверей и видео, загруженные через админку

Переменные окружения
  ADMIN_PASSWORD      пароль админки (обязательно, придумайте длинный)
  TELEGRAM_BOT_TOKEN  токен бота от @BotFather
  TELEGRAM_CHAT_ID    ID чата или группы (можно несколько через запятую)
  DATA_DIR            папка для данных (по умолчанию ./data)
  MAX_VIDEO_MB        лимит видео из админки (по умолчанию 100)
  MAX_IMAGE_MB        лимит фото (по умолчанию 10)

Как узнать chat id: напишите боту сообщение, откройте
https://api.telegram.org/bot<TOKEN>/getUpdates и найдите "chat":{"id":...}
Для группы сначала добавьте бота в группу и напишите там сообщение.

Запуск у себя
  ADMIN_PASSWORD=секрет TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node server.js
  сайт http://localhost:3000, админка http://localhost:3000/admin/

Render (проверка)
  1. Залейте папку на GitHub.
  2. Render -> New -> Web Service (или Blueprint, он подхватит render.yaml).
  3. Build Command: npm install    Start Command: npm start
  4. Environment: добавьте три переменные выше.
  Важно про бесплатный тариф: сервис засыпает после ~15 минут без заходов
  (первая загрузка после сна около минуты), а файлы на диске сбрасываются при
  перезапуске и новом деплое. Это значит, что двери, загруженные фото и видео, добавленные в админке,
  могут вернуться к демо-набору. Заявки в Telegram при этом не теряются.

Боевой запуск
  Вариант 1: Render с платным тарифом и Disk (см. render.yaml), DATA_DIR=/var/data.
  Вариант 2: любой VPS: node server.js под pm2 или systemd, а HTTPS и домен
  через Caddy или nginx (проксировать на порт 3000).
Домен на Render: Settings -> Custom Domains, затем DNS-записи, которые покажет Render.
