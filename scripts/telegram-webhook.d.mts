export function runTelegramSetup(
  args: string[],
  environment: Record<string, string | undefined>,
  fetcher?: typeof fetch,
  write?: (line: string) => void,
): Promise<number>;
