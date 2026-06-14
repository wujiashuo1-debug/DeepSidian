export interface FetchResult {
  ok: boolean;
  text: string;
  title: string;
  finalUrl: string;
  byteCount: number;
  truncated: boolean;
  error?: string;
}
