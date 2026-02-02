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

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const pages = event.data.pages ?? [];
  const sorted = [...pages].sort((a, b) => a.confidence - b.confidence);
  const response: WorkerResponse = { pages: sorted };
  self.postMessage(response);
};
