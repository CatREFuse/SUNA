// Preserve the original server import while sharing the v3 Client web service.
export {
  createWebAccessService as createWebsearchService,
  TAVILY_SEARCH_ENDPOINT,
  DEEPSEEK_WEB_BASE_URL,
} from './web-access.mjs';
