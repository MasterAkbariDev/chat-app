/** True for an upload file name that can never be reused for other bytes: a content hash
 *  (16+ hex chars) or a millisecond timestamp, as both the old and new app name them. */
export function isUniqueUploadName(filePath: string): boolean {
  const name = filePath.split(/[\\/]/).pop() ?? "";
  return /[0-9a-f]{16,}/i.test(name) || /\d{12,}/.test(name);
}
