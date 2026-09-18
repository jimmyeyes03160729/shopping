"""
Deprecated compatibility module.

The live comparison flow has moved to worker/src/index.js so that:
1. prices and URLs come from shopping-site search data instead of Gemini guesses;
2. GEMINI_API_KEY stays server-side;
3. Gemini only normalizes product names and dynamic specs.
"""

def run_price_comparison(*args, **kwargs):
    raise RuntimeError(
        "run_price_comparison() is deprecated. Deploy the Cloudflare Worker "
        "and use POST /api/search instead."
    )
