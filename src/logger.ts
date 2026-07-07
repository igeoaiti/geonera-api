import pino from "pino";
import pretty from "pino-pretty";

const isProduction = process.env.NODE_ENV === "production";

export const logger = isProduction
  ? pino({
      level: process.env.LOG_LEVEL || "info",
      base: {
        service: "geonera-api",
      },
    })
  : pino(
      {
        level: process.env.LOG_LEVEL || "info",
        base: {
          service: "geonera-api",
        },
      },
      pretty({
        colorize: true,
        translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
        ignore: "pid,hostname",
      })
    );
