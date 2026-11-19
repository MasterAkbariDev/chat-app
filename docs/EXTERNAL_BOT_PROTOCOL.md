# External bot protocol

Register a bot by setting `EXTERNAL_BOTS` to a JSON array of objects with `key`, `name`, `description`, `endpoint`, `token`, and `accessScope`. The endpoint is deployment-controlled; keep tokens private, use HTTPS across hosts or a private local network, and configure the scope in `BOT_ACCESS_GRANTS`. The app checks the user's scope before forwarding any event. A registration replaces the built-in bot of the same key.

The app sends a bearer-authenticated JSON POST to the endpoint. `type: "screen"` events carry `userId`, `screenId`, and `params` and return a `BotMenuScreen`. `type: "action"` events additionally carry `actionId` and a `files` array (name, MIME type, and base64 contents), and return `{ "screen": BotMenuScreen }`. Navigation, forms, buttons, and notices use the generic contract in `backend/src/bots/bot.interface.ts`. A separate service can implement this protocol in any language; no new chat-backend handler is needed.

An external bot runs independently of the chat application. Keep its endpoint private or protected by HTTPS, and keep its control interfaces restricted. The external bot is trusted to perform its own authorization for any resources it controls and must not treat the forwarded user ID as independently authenticated outside this authenticated channel.

For an unsolicited notice, the external service may POST `{ "userId": "...", "text": "..." }` to `/v1/bot-events/<key>/messages` using the same bearer token. The backend checks that the bot is registered and that the target user has its configured access scope before saving the message. Bot chat clients refresh their history periodically. Use a trusted private network or HTTPS and keep the token secret.

Action notices and bot-posted notices are stored per bot and user and can be shown across devices. This protocol is not Telegram-compatible and does not yet let end users create bot tokens themselves.
