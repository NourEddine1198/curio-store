import { NextRequest, NextResponse } from "next/server";

// CORS: Allow curiodz.com (and localhost for dev) to call our API
const ALLOWED_ORIGINS = [
  "https://curiodz.com",
  "https://www.curiodz.com",
  "http://localhost:5500",   // VS Code Live Server
  "http://127.0.0.1:5500",
  "http://localhost:3000",
];

function getCorsHeaders(origin: string | null) {
  const isAllowed = origin && ALLOWED_ORIGINS.includes(origin);
  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key, X-Webhook-Secret",
    "Access-Control-Max-Age": "86400",
  };
}

export function middleware(request: NextRequest) {
  const origin = request.headers.get("origin");

  // Handle preflight (OPTIONS) requests
  if (request.method === "OPTIONS") {
    return new NextResponse(null, {
      status: 204,
      headers: getCorsHeaders(origin),
    });
  }

  // Add CORS headers to all API responses
  const response = NextResponse.next();
  const headers = getCorsHeaders(origin);
  Object.entries(headers).forEach(([key, value]) => {
    response.headers.set(key, value);
  });

  return response;
}

// Only apply to API routes
export const config = {
  matcher: "/api/:path*",
};
