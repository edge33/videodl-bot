export interface DownloadLimits {
  durationSeconds: number;
  fileBytes: number;
  reserveBytes: number;
  deadlineMs: number;
}
export const defaultLimits: DownloadLimits = {
  durationSeconds: 7200,
  fileBytes: 4 * 1024 ** 3,
  reserveBytes: 2 * 1024 ** 3,
  deadlineMs: 3600000,
};
