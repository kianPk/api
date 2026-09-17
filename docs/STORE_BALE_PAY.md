# Store + Bale Pay deploy notes

## Env (API pod / secret)

| Variable | Required | Purpose |
|----------|----------|---------|
| `BALE_BOT_TOKEN` | yes (for checkout) | Bale bot token from BotFather |
| `BALE_PROVIDER_TOKEN` | yes (for checkout) | Wallet payment token (`@botfather`) |
| `BALE_BOT_USERNAME` | recommended | Deep link `https://ble.ir/<username>?start=pay_…` |
| `BALE_WEBHOOK_SECRET` | optional | If set, webhook must send header `x-bale-webhook-secret` |

Test provider token from Bale docs: `WALLET-TEST-1111111111111111`

## Webhook

Point the bot webhook at:

```text
https://api.yguard.ir/store/bale-webhook
```

Example:

```bash
curl -X POST "https://tapi.bale.ai/bot${BALE_BOT_TOKEN}/setWebhook" \
  -H 'content-type: application/json' \
  -d '{"url":"https://api.yguard.ir/store/bale-webhook"}'
```

## Hasura

Apply migration `1886000000000_store_products_orders` and reload metadata so `store_products` / `store_orders` exist.

## Flow check

1. Admin → Settings → Store → add an active product
2. LeftNav → Store → Buy
3. Open Bale deep link → `/start pay_<orderId>` → pay invoice
4. Order status becomes `paid` in `store_orders`
