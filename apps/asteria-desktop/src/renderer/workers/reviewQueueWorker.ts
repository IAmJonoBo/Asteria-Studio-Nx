type ReviewPage = {
  id: string;
  filename: string;
  reason: string;
  confidence: number;
  thumbnailPath?: string;
  issues: string[];
};

type WorkerRequest = {
  pages: ReviewPage[];
};

type WorkerResponse = {
  pages: ReviewPage[];
};

const workerScope = globalThis as unknown as {
  onmessage: ((event: { data: WorkerRequest }) => void) | null;
  postMessage: (message: WorkerResponse) => void;
};

workerScope.onmessage = (event: { data: WorkerRequest }): void => {
  const pages = event.data.pages ?? [];
  const sorted = [...pages].sort((a, b) => a.confidence - b.confidence);
  const response: WorkerResponse = { pages: sorted };
  workerScope.postMessage(response);
};

export {};
