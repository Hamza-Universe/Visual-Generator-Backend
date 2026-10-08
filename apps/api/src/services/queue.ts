import { Queue, QueueEvents } from 'bullmq';
import { RENDER_QUEUE_NAME, defaultRenderJobOptions } from '@app/schema';

export interface RenderQueueOptions {
  attempts?: number;
  backoffMs?: number;
}

export const createRenderQueue = (redisUrl: string, options: RenderQueueOptions = {}) => {
  const url = new URL(redisUrl);
  const jobOptions = defaultRenderJobOptions({
    attempts: options.attempts,
    backoffMs: options.backoffMs,
  });
  const queue = new Queue<{ renderId: string }>(RENDER_QUEUE_NAME, {
    connection: {
      host: url.hostname,
      port: Number(url.port || 6379),
      password: url.password || undefined,
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      },
    },
    defaultJobOptions: {
      attempts: jobOptions.attempts,
      backoff: jobOptions.backoff,
      removeOnComplete: jobOptions.removeOnComplete,
      removeOnFail: jobOptions.removeOnFail,
    },
  });
  const queueEvents = new QueueEvents(RENDER_QUEUE_NAME, {
    connection: {
      host: url.hostname,
      port: Number(url.port || 6379),
      password: url.password || undefined,
    },
  });
  queueEvents.on('error', (err) => {
    console.error('Render queue events error:', err.message);
  });
  queue.on('error', (err) => {
    console.error('Render queue error:', err.message);
  });
  return queue;
};
