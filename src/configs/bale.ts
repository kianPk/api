import { BaleConfig } from "./types/BaleConfig";

export default (): {
  bale: BaleConfig;
} => ({
  bale: {
    botToken: process.env.BALE_BOT_TOKEN || "",
    providerToken: process.env.BALE_PROVIDER_TOKEN || "",
    botUsername: process.env.BALE_BOT_USERNAME || "",
    webhookSecret: process.env.BALE_WEBHOOK_SECRET || "",
  },
});
