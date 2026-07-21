import { env } from "./config/env";
import { app } from "./app";

app.listen(env.PORT, () => {
  console.log(`Aurore backend demarre sur le port ${env.PORT} (${env.NODE_ENV})`);
});
