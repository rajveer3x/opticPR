import type { NextFunction, Request, Response } from "express";

export function cors(request: Request, response: Response, next: NextFunction): void {
  const origin = request.header("origin");
  const allowedOrigins = ["http://localhost:5173", process.env.APP_WEB_URL].filter(Boolean);

  if (origin !== undefined && allowedOrigins.includes(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Credentials", "true");
    response.setHeader("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS");
    response.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Requested-With",
    );

    if (request.method === "OPTIONS") {
      response.sendStatus(204);
      return;
    }
  }

  next();
}
