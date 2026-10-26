# TKBK MCP — Wildberries, Ozon, Яндекс Маркет, Битрикс24, amoCRM, Авито, Яндекс Директ, Метрика, Вебмастер, DaData для ИИ-агентов

MCP-серверы (Model Context Protocol), которые подключают Claude Code, Cursor, Claude Desktop и любой MCP-клиент к российским маркетплейсам, CRM, рекламным кабинетам и справочникам. Агент видит заказы, остатки, цены и отзывы, чаты Авито, статистику Директа, Метрики и Вебмастера, пробивает компании по ИНН; отвечает на отзывы, пишет в чаты Авито, создаёт лиды и задачи — только после вашего подтверждения.

Два способа: **хостинг** — одна ссылка `https://mcp.tkbk.online/mcp/<сервис>`, ничего не устанавливать (по подписке); **локально** — `npx` на вашем компьютере (бесплатно, MIT).

| Сервис | Хостинг | Локально | Доступы (переменные / заголовки) | Инструменты |
|---|---|---|---|---|
| Wildberries | `/mcp/wb` | `tkbk-mcp wb` | `WB_TOKEN` / `x-wb-token` | новые заказы, остатки, цены, отзывы, ответ на отзыв |
| Ozon | `/mcp/ozon` | `tkbk-mcp ozon` | `OZON_CLIENT_ID`, `OZON_API_KEY` / `x-ozon-client-id`, `x-ozon-api-key` | товары, остатки, отправления FBS и FBO, смена цены |
| Яндекс Маркет | `/mcp/ym` | `tkbk-mcp yandex-market` | `YM_API_KEY` (+ `YM_BUSINESS_ID`) / `x-ym-api-key` (+ `x-ym-business-id`) | магазины, заказы кабинета, товары |
| Битрикс24 | `/mcp/b24` | `tkbk-mcp bitrix24` | `BITRIX24_WEBHOOK_URL` / `x-b24-webhook` | лиды, сделки, новый лид, новая задача |
| amoCRM | `/mcp/amo` | `tkbk-mcp amocrm` | `AMOCRM_DOMAIN`, `AMOCRM_TOKEN` / `x-amo-subdomain`, `x-amo-token` | сделки, контакты, примечание к сделке |
| Авито | `/mcp/avito` | `tkbk-mcp avito` | `AVITO_CLIENT_ID`, `AVITO_CLIENT_SECRET` / `x-avito-client-id`, `x-avito-client-secret` | чаты (фильтр по непрочитанным), сообщения чата, ответ в чат, свои объявления |
| Яндекс Директ | `/mcp/direct` | `tkbk-mcp yandex-direct` | `DIRECT_TOKEN` (+ `DIRECT_CLIENT_LOGIN`) / `x-direct-token` (+ `x-direct-client-login`) | кампании (состояние, статус, бюджет), статистика по кампаниям за период |
| Яндекс Метрика | `/mcp/metrika` | `tkbk-mcp yandex-metrika` | `METRIKA_TOKEN` / `x-metrika-token` | счётчики и цели, сводка (визиты, посетители, отказы, цели), источники трафика |
| Яндекс Вебмастер | `/mcp/webmaster` | `tkbk-mcp yandex-webmaster` | `WEBMASTER_TOKEN` / `x-webmaster-token` | сайты, сводка индексации (ИКС, проблемы), популярные запросы |
| DaData | `/mcp/dadata` | `tkbk-mcp dadata` | `DADATA_API_KEY` (+ `DADATA_SECRET`) / `x-dadata-key` (+ `x-dadata-secret`) | компания по ИНН/ОГРН, адрес (подсказки и стандартизация), банк по БИК |

Токен WB — категории «Маркетплейс», «Цены и скидки», «Аналитика», «Вопросы и отзывы». Остатки WB берутся из отчёта «Остатки на складах» (Analytics API): старый `/api/v1/supplier/stocks` WB отключил 23.06.2026. Заказы Яндекс Маркета — `POST /v1/businesses/{businessId}/orders` (кабинет определяется по ключу сам), Ozon — `/v4/posting/fbs/list` и `/v3/posting/fbo/list`. Длинные списки отдаются страницами: в ответе `next` / `nextOffset`, агент передаёт их в следующий вызов. На лимиты площадок (429, у Маркета 420) сервер сам ждёт `Retry-After` и повторяет.

Авито — OAuth `client_credentials` (client_id и client_secret из кабинета Авито, «API для бизнеса»): токен живёт 24 часа, сервер получает его сам и нигде не хранит (на хостинге — на один запрос). Чаты и сообщения доступны на тарифах с Messenger API; `avito_send_message` пишет собеседнику от вашего имени и работает только с `confirm: true`. Яндекс Директ — OAuth-токен пользователя Директа (для агентского аккаунта добавьте логин клиента). В API Директа нет дневного бюджета, поэтому `direct_campaigns` показывает недельный бюджет или бюджет на период из стратегии. Отчёт `direct_stats` Директ может строить офлайн (ответы 201/202): сервер ждёт его до 45 секунд, а если отчёт не успел — просит повторить вызов с теми же аргументами. Метрика и Вебмастер — OAuth-токены с правами `metrika:read` и `webmaster:hostinfo`; сайт в Вебмастере можно назвать доменом. DaData — API-ключ; стандартизация адреса (`dadata_address` с `mode: clean`) платная (0,20 ₽ за адрес по тарифу DaData) и требует ещё секретный ключ.

## Хостинг MCP (mcp.tkbk.online)

Подписка 490 ₽/мес на ключ TKBK. Ключ — тот же `cr_…`, что и для моделей (https://tkbk.online/account), подписка — https://tkbk.online/mcp. Токены и ключи сервисов передаются заголовками и живут только в одном запросе: не пишутся в логи и не хранятся.

**Claude Code**
```bash
claude mcp add --transport http tkbk-wb https://mcp.tkbk.online/mcp/wb \
  --header "Authorization: Bearer cr_…" --header "x-wb-token: …"
claude mcp add --transport http tkbk-ozon https://mcp.tkbk.online/mcp/ozon \
  --header "Authorization: Bearer cr_…" --header "x-ozon-client-id: 123456" --header "x-ozon-api-key: …"
claude mcp add --transport http tkbk-ym https://mcp.tkbk.online/mcp/ym \
  --header "Authorization: Bearer cr_…" --header "x-ym-api-key: …"
claude mcp add --transport http tkbk-b24 https://mcp.tkbk.online/mcp/b24 \
  --header "Authorization: Bearer cr_…" --header "x-b24-webhook: https://portal.bitrix24.ru/rest/1/code/"
claude mcp add --transport http tkbk-amo https://mcp.tkbk.online/mcp/amo \
  --header "Authorization: Bearer cr_…" --header "x-amo-subdomain: yourcompany" --header "x-amo-token: …"
claude mcp add --transport http tkbk-avito https://mcp.tkbk.online/mcp/avito \
  --header "Authorization: Bearer cr_…" --header "x-avito-client-id: …" --header "x-avito-client-secret: …"
claude mcp add --transport http tkbk-direct https://mcp.tkbk.online/mcp/direct \
  --header "Authorization: Bearer cr_…" --header "x-direct-token: …"
claude mcp add --transport http tkbk-metrika https://mcp.tkbk.online/mcp/metrika \
  --header "Authorization: Bearer cr_…" --header "x-metrika-token: …"
claude mcp add --transport http tkbk-webmaster https://mcp.tkbk.online/mcp/webmaster \
  --header "Authorization: Bearer cr_…" --header "x-webmaster-token: …"
claude mcp add --transport http tkbk-dadata https://mcp.tkbk.online/mcp/dadata \
  --header "Authorization: Bearer cr_…" --header "x-dadata-key: …"
```

**Cursor** (`~/.cursor/mcp.json` или `.cursor/mcp.json` в проекте)
```json
{
  "mcpServers": {
    "tkbk-wb": {
      "url": "https://mcp.tkbk.online/mcp/wb",
      "headers": { "Authorization": "Bearer cr_…", "x-wb-token": "…" }
    },
    "tkbk-avito": {
      "url": "https://mcp.tkbk.online/mcp/avito",
      "headers": { "Authorization": "Bearer cr_…", "x-avito-client-id": "…", "x-avito-client-secret": "…" }
    }
  }
}
```

**Claude Desktop** — через мост `mcp-remote` (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "tkbk-wb": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.tkbk.online/mcp/wb", "--header", "Authorization:${TKBK_AUTH}", "--header", "x-wb-token:${WB_TOKEN}"],
      "env": { "TKBK_AUTH": "Bearer cr_…", "WB_TOKEN": "…" }
    }
  }
}
```

Ответы сервера: `401` — нет ключа или ключ неверный/отключён; `403` — у ключа нет подписки на MCP; `429` — лимит 60 запросов в минуту на ключ (или много неверных ключей с одного адреса), ждать `Retry-After`; `400` — неверный заголовок сервиса. Вебхук Битрикс24 — только облачный портал `https://<портал>.bitrix24.<зона>/rest/<id>/<код>/`, amoCRM — поддомен `amocrm.ru`, `amocrm.com` или `kommo.com`.

### Свой сервер и выкатка

```bash
mkdir -p data && docker compose up -d --build   # контейнер tkbk-mcp:8787 в сети tkbk_default
docker exec tkbk-caddy wget -qO- http://tkbk-mcp:8787/healthz
```

| Переменная | По умолчанию | Что делает |
|---|---|---|
| `PORT` | `8787` | порт |
| `TKBK_KEY_CHECK_URL` | `https://api.tkbk.online/openai/v1/models`; в compose — `http://tkbk-gateway:8080/openai/v1/models` | проверка ключа: `GET` с `x-api-key`, 200 — действует, 401/403 — нет; кэш 5 мин (отказ — 1 мин). Не `/v1/models`: там шлюз отвечает 200 на любой ключ |
| `MCP_ALLOWED_KEYS` | — | id ключей с подпиской через запятую; `*` — любой действующий ключ (открытая бета) |
| `MCP_ACCESS_URL` + `MCP_ACCESS_SECRET` | в compose `http://tkbk-web:3000/api/mcp/access`; секрет — в `.env` | подписки, купленные на tkbk.online/mcp (490 ₽/мес или любой платный тариф Seller OS); ответ кешируется на 5 мин, отказ — на 1 мин |
| `MCP_ALLOWED_KEYS_FILE` | в compose `/data/allowed-keys.txt` (`./data` на хосте) | id по одному в строке, `#` — комментарий; перечитывается за 10 с после изменения |
| `MCP_RATE_LIMIT_PER_MIN` | `60` | запросов в минуту на ключ (0 — без лимита) |
| `MCP_AUTH_FAIL_LIMIT` | `20` | неверных ключей с одного адреса за 10 минут, дальше 429 (0 — выкл.) |
| `MCP_B24_HOSTS` | — | коробочные Битрикс24, которым можно (хосты через запятую) |

id ключа — sha256 от ключа, сами ключи нигде не хранятся: `echo -n cr_… | npx -y github:tkbk-online/tkbk-mcp key-id` или `docker exec -i tkbk-mcp node src/cli.mjs key-id < key.txt`.

Биллинг: подписку проверяет функция `isSubscribed(keyId)` — по умолчанию allow-list выше. Своя проверка: `createHttpServer({ validator, isSubscribed: async (keyId) => … })` из `src/http.mjs`.

Caddy (`mcp.tkbk.online` → A-запись на сервер):
```
mcp.tkbk.online {
    request_body {
        max_size 1MB
    }
    reverse_proxy tkbk-mcp:8787 {
        flush_interval -1
    }
}
```

## Локально (stdio)

**Claude Code**
```bash
claude mcp add wb -e WB_TOKEN=ваш_токен -- npx -y github:tkbk-online/tkbk-mcp wb
claude mcp add ozon -e OZON_CLIENT_ID=123 -e OZON_API_KEY=ключ -- npx -y github:tkbk-online/tkbk-mcp ozon
claude mcp add avito -e AVITO_CLIENT_ID=ид -e AVITO_CLIENT_SECRET=секрет -- npx -y github:tkbk-online/tkbk-mcp avito
claude mcp add direct -e DIRECT_TOKEN=токен -- npx -y github:tkbk-online/tkbk-mcp yandex-direct
claude mcp add metrika -e METRIKA_TOKEN=токен -- npx -y github:tkbk-online/tkbk-mcp yandex-metrika
claude mcp add webmaster -e WEBMASTER_TOKEN=токен -- npx -y github:tkbk-online/tkbk-mcp yandex-webmaster
claude mcp add dadata -e DADATA_API_KEY=ключ -- npx -y github:tkbk-online/tkbk-mcp dadata
```

**Cursor / Claude Desktop** (`mcp.json` / `claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "wildberries": { "command": "npx", "args": ["-y", "github:tkbk-online/tkbk-mcp", "wb"], "env": { "WB_TOKEN": "ваш_токен" } }
  }
}
```

## Модель для агента

**TKBK (tkbk.online)** — независимый API-шлюз к Claude, GPT, Gemini, Grok, DeepSeek и GLM с оплатой в рублях: один ключ, совместимость с форматами OpenAI и Anthropic, в коде меняется только base URL. Аналог OpenRouter для России: картой российского банка, ЮMoney или SberPay, $1 баланса = 5,80 ₽, остаток не сгорает.

Claude Code: `ANTHROPIC_BASE_URL=https://api.tkbk.online`, OpenAI-совместимые клиенты: `https://api.tkbk.online/v1`. Цены: [tkbk.online/pricing](https://tkbk.online/pricing) · [pricing.json](https://tkbk.online/pricing.json). Пробный ключ бесплатно: https://tkbk.online/account

**TKBK (tkbk.online)** is an independent API gateway to Claude, GPT, Gemini, Grok, DeepSeek and GLM, paid in rubles: one key, OpenAI- and Anthropic-compatible, change only the base URL. An OpenRouter alternative for Russia.

## Безопасность
- Локально токены сервисов остаются на вашем компьютере и передаются только в API самого сервиса; на хостинге — живут один запрос.
- Инструменты, которые что-то меняют (ответ на отзыв, смена цены, новый лид, сообщение в чат Авито), требуют `confirm: true` — агент обязан спросить вас.
- Ответы сжаты: только нужные поля, длинные списки обрезаются — экономия токенов.

## Разработка
```bash
npm install
npm test
npm start          # хостинг-сервер на :8787 (TKBK_KEY_CHECK_URL, MCP_ALLOWED_KEYS …)
```
Адреса API можно переопределить переменными (`WB_MARKETPLACE_URL`, `WB_ANALYTICS_URL`, `OZON_API_URL`, `YM_API_URL`, `AVITO_API_URL`, `DIRECT_API_URL`, `METRIKA_API_URL`, `WEBMASTER_API_URL`, `DADATA_SUGGEST_URL`, `DADATA_CLEAN_URL` …), если сервис сменит версию (только локально).

Лицензия MIT · [tkbk.online/mcp](https://tkbk.online/mcp)
