import express from "express";
import { healthRouter } from "./routes/health";
import { actionsRouter } from "./routes/actions";

export const app = express();

app.use(express.json());
app.use(healthRouter);
app.use(actionsRouter);
