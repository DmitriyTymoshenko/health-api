# CLAUDE.md — Health API

## Проект
Express + MongoDB REST API для health dashboard Дмитра.
- **Порт:** 3001 (systemd: health-api)
- **DB:** MongoDB `health_tracker` (localhost:27017)
- **GitHub:** https://github.com/DmitriyTymoshenko/health-api

## Структура
```
routes/          — 16 JS route files (legacy, робочі)
src/
  types/         — TypeScript interfaces (index.ts)
  middleware/    — validate.ts (normalizeNutrition, requireFields, validateDate, normalizeSupplementId)
  tests/         — Jest тести (29 тестів)
server.js        — Entry point
```

## Правила розробки

### Гілки
- `main` — стабільний продакшн
- Всі зміни робити в окремій гілці: `git checkout -b feature/<назва>`
- Перед мерджем в main — запустити тести: `npm test`
- Мерджити тільки якщо всі тести зелені

### Деплой
```bash
# Деплой через гілку
git checkout -b feature/my-feature
# ... зміни ...
npm test        # обов'язково!
git add -A && git commit -m "feat: ..."
git checkout main && git merge feature/my-feature
npm run deploy  # тести + push + рестарт
git branch -d feature/my-feature
```

### MongoDB колекції
| Колекція | Призначення |
|---|---|
| `nutrition_log` | Записи їжі |
| `weight_log` | Вага |
| `water_log` | Вода |
| `steps` | Кроки |
| `supplements_log` | Старий лог вітамінів |
| `supplement_catalog` | Каталог добавок |
| `supplement_cycles` | Цикли прийому |
| `supplement_intake` | Денний трекер |
| `supplement_knowledge` | Склад кожної добавки (БЖУ, нутрієнти) |
| `lab_results` | Результати аналізів |
| `daily_metrics` | WHOOP дані |
| `workouts` | Тренування |
| `goals` | Цілі |
| `user_settings` | Налаштування |

### Важливі правила
1. **supplement_id** — завжди зберігати як `Number`, не `String`
2. **Nutrition** — підтримувати обидва формати: `protein` і `protein_g`. Middleware `normalizeNutrition` конвертує автоматично.
3. **Дати** — завжди `YYYY-MM-DD` string
4. **Нові endpoints** — додавати через TypeScript (`src/`) і писати тест

### Тести
```bash
npm test              # запустити всі тести
npm run test:watch    # watch mode
```
Тести живуть в `src/tests/*.test.ts`. При додаванні нового middleware або критичної логіки — додавати тест.

### Перезапуск API після змін в routes/
```bash
fuser -k 3001/tcp && cd /tmp/health-api && node server.js &
```
