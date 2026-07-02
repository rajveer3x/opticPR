import { Router } from "express";

import { authRouter } from "./auth.js";
import { pullRequestsRouter } from "./pull-requests.js";

export const apiV1Router: Router = Router();

apiV1Router.use("/auth", authRouter);
apiV1Router.use("/pull-requests", pullRequestsRouter);
