export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorJson(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof AppError) {
    console.warn(`app_error ${error.status} ${error.code}: ${error.message}`);
    return errorJson(error.status, error.code, error.message);
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return errorJson(504, "timeout", "The deployment timed out. If it is cold-starting, wait and run again.");
  }
  console.error(error);
  return errorJson(500, "internal", "Something went wrong running this app.");
}
