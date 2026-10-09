# TKBK MCP — Wildberries, Ozon, Яндекс Маркет, Битрикс24, amoCRM для ИИ-агентов

MCP-серверы (Model Context Protocol), которые подключают Claude Code, Cursor, Claude Desktop и любой MCP-клиент к российским маркетплейсам и CRM. Агент видит заказы, остатки, цены и отзывы, отвечает на отзывы, создаёт лиды и задачи — только после вашего подтверждения.

| Сервис | Команда | Переменные | Инструменты |
|---|---|---|---|
| Wildberries | `tkbk-mcp wb` | `WB_TOKEN` | новые заказы, остатки, цены, отзывы, ответ на отзыв |
| Ozon | `tkbk-mcp ozon` | `OZON_CLIENT_ID`, `OZON_API_KEY` | товары, остатки, FBS-отправления, смена цены |
| Яндекс Маркет | `tkbk-mcp yandex-market` | `YM_API_KEY` | магазины, заказы, офферы |
| Битрикс24 | `tkbk-mcp bitrix24` | `BITRIX24_WEBHOOK_URL` | лиды, сделки, новый лид, новая задача |
| amoCRM | `tkbk-mcp amocrm` | `AMOCRM_DOMAIN`, `AMOCRM_TOKEN` | сделки, контакты, примечание к сделке |

## Подключение

**Claude Code**
```bash
claude mcp add wb -e WB_TOKEN=ваш_токен -- npx -y @tkbk/mcp wb
claude mcp add ozon -e OZON_CLIENT_ID=123 -e OZON_API_KEY=ключ -- npx -y @tkbk/mcp ozon
```

**Cursor / Claude Desktop** (`mcp.json` / `claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "wildberries": { "command": "npx", "args": ["-y", "@tkbk/mcp", "wb"], "env": { "WB_TOKEN": "ваш_токен" } }
  }
}
```

Модель для агента — любая, через один ключ TKBK: Claude, GPT, DeepSeek, GLM, Grok (`ANTHROPIC_BASE_URL=https://api.tkbk.online/claude`). Пробный ключ бесплатно: https://tkbk.online/account

## Безопасность
- Токены сервисов остаются на вашем компьютере и передаются только в API самого сервиса.
- Инструменты, которые что-то меняют (ответ на отзыв, смена цены, новый лид), требуют `confirm: true` — агент обязан спросить вас.
- Ответы сжаты: только нужные поля, длинные списки обрезаются — экономия токенов.

## Разработка
```bash
npm install
npm test
```
Адреса API можно переопределить переменными (`WB_MARKETPLACE_URL`, `OZON_API_URL`, `YM_API_URL` …), если сервис сменит версию.

Лицензия MIT · [tkbk.online/mcp](https://tkbk.online/mcp)
