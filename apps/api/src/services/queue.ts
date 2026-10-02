import { Queue } from 'bullmq';
export const createRenderQueue = (redisUrl: string) => {
  const url = new URL(redisUrl);
  return new Queue<{ renderId: string }>('render', {
    connection: {
      host: url.hostname,
      port: Number(url.port || 6379),
      password: url.password || undefined,
    },
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  });
};
