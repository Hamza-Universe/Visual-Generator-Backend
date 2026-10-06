import { Queue, QueueEvents } from 'bullmq';
export const createRenderQueue = (redisUrl: string) => {
  const url = new URL(redisUrl);
  const queue = new Queue<{ renderId: string }>('render', {
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
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  });
  const queueEvents = new QueueEvents('render', {
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
