# Деплой (Bothost и др.)

## Почему нет `dist/` в Git

`dist/` в `.gitignore` — артефакты собираются при деплое, не коммитятся.

## Bothost

1. **Использовать домен** — да (админка + API).
2. **Собственный Dockerfile** — да (рекомендуется).
3. **Главный файл** — укажи **`server.js`** (в корне), не `dist/server.js`.  
   Скрипт при старте выполнит `npm run build:all`, если `dist` ещё нет.

Если платформа всё равно жёстко запускает `node dist/server.js` — в настройках команды запуска поставь:

```bash
npm run build:all && node dist/server.js
```

или:

```bash
npm start
```

(`npm start` → `node server.js` → сборка + API)

## Переменные

- `MRKT_AUTH` — обязательно для API MRKT
- `PORT` — обычно задаёт хостинг
- `PARSER_DELAY_MS` и др. — только для `npm run parse`, не для веб-сервера

## Данные

`data/` не в Git. После деплоя нужен `npm run parse` (в консоли контейнера) или том на `/app/data`.
