import amqp from "amqplib";
import { logger } from "./logger";
import { generateAIPrediction } from "./services/forex";

const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://sans:!PQssw0rd123@localhost:5672";

let connection: amqp.ChannelModel | null = null;
let channel: amqp.Channel | null = null;
let isConnecting = false;

export async function getChannel(): Promise<amqp.Channel> {
  if (channel) return channel;

  if (isConnecting) {
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    return getChannel();
  }

  isConnecting = true;
  try {
    if (!connection) {
      logger.info({ url: RABBITMQ_URL }, "[RabbitMQ] Connecting...");
      connection = await amqp.connect(RABBITMQ_URL);

      connection.on("error", (err: Error) => {
        logger.error(err, "[RabbitMQ] Connection error");
        connection = null;
        channel = null;
      });

      connection.on("close", () => {
        logger.warn("[RabbitMQ] Connection closed. Retrying connection...");
        connection = null;
        channel = null;
      });

      logger.info("[RabbitMQ] Connected successfully.");
    }

    if (connection && !channel) {
      channel = await connection.createChannel();
      channel.on("error", (err: Error) => {
        logger.error(err, "[RabbitMQ] Channel error");
        channel = null;
      });
      channel.on("close", () => {
        logger.warn("[RabbitMQ] Channel closed.");
        channel = null;
      });
    }
  } catch (err: any) {
    connection = null;
    channel = null;
    logger.error(err, `[RabbitMQ] Failed to connect to broker: ${err.message}`);
    throw err;
  } finally {
    isConnecting = false;
  }

  if (!connection || !channel) {
    throw new Error("RabbitMQ connection or channel is missing");
  }

  return channel;
}

export async function checkRabbitMQHealth(): Promise<boolean> {
  try {
    await getChannel();
    return true;
  } catch {
    return false;
  }
}

// Start consumers for scheduler jobs
export async function startRabbitMQConsumers() {
  const queues = [
    "jobs.maintenance",
    "jobs.sync",
    "jobs.ticks.regular",
    "jobs.ticks.backfill",
    "jobs.candles.regular",
    "jobs.candles.backfill",
  ];

  try {
    const ch = await getChannel();
    logger.info("[RabbitMQ] Initializing consumer loops...");

    for (const queue of queues) {
      await ch.assertQueue(queue, { durable: true });
      
      await ch.consume(queue, async (msg) => {
        if (!msg) return;

        try {
          const content = msg.content.toString();
          const data = JSON.parse(content);
          logger.info({ queue, data }, `[RabbitMQ Consumer] Received task on ${queue}`);

          // Trigger simulated AI predictions when scheduler triggers ticks-regular
          if (queue === "jobs.ticks.regular" || queue === "jobs.ticks.backfill") {
            const symbols = ["EURUSD", "GBPUSD", "USDJPY"];
            logger.info("[RabbitMQ Consumer] Ticks trigger detected. Simulating AI trading evaluations...");
            for (const symbol of symbols) {
              await generateAIPrediction(symbol);
            }
          }

          ch.ack(msg);
        } catch (err: any) {
          logger.error(err, `[RabbitMQ Consumer] Error processing message on queue ${queue}: ${err.message}`);
          // Negative acknowledgment, re-queue if desired (set to false to prevent infinite loops)
          ch.nack(msg, false, false);
        }
      });

      logger.info({ queue }, `[RabbitMQ] Listening on queue`);
    }
  } catch (err: any) {
    logger.error(err, `[RabbitMQ] Consumer registration failed. Retrying in 5 seconds...`);
    setTimeout(() => startRabbitMQConsumers(), 5000);
  }
}
