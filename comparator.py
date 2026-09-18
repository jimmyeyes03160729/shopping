import os
import json
import time
import urllib.parse
import httpx
from bs4 import BeautifulSoup
from google import genai
from google.genai.errors import APIError
from pydantic import BaseModel, Field

# 從 GitHub Secrets 自動載入
client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))

class ProductItem(BaseModel):
    store_name: str = Field(description="購物網站名稱")
    canonical_name: str = Field(description="標準商品品名")
    price: float = Field(description="商品純數值價格")
    currency: str = Field(default="TWD", description="幣別")
    matched_group_id: str = Field(description="相同規格的群組 ID，例如 iphone-15-128gb")
    key_specs: str = Field(description="規格摘要字串，例如 128GB / A16 / 黑色")
    url: str = Field(description="該商城的首頁或可能連結")
    is_target_match: bool = Field(description="是否與使用者關鍵字吻合")

class ComparisonResult(BaseModel):
    items: list[ProductItem] = Field(description="比價列表")

def extract_domain_name(url: str) -> str:
    """自動從首頁網址提取網域名稱"""
    if not url.startswith("http"):
        url = "https://" + url
    parsed = urllib.parse.urlparse(url)
    domain = parsed.netloc or parsed.path
    return domain.replace("www.", "")

def run_price_comparison(keyword: str, store_urls: list[str]) -> list[ProductItem]:
    domains = [extract_domain_name(url) for url in store_urls if url.strip()]
    
    prompt = f"""
    使用者正在進行電商比價，關鍵字：「{keyword}」。
    目標購物官網網域清單：{domains}

    任務：
    1. 針對上述每個購物官網，精準評估該站在此關鍵字下對應的主力現貨商品。
    2. 提取出乾淨價格（數值）。
    3. 提取核心規格參數（如容量、型號、顏色等）。
    4. 給予完全相同規格的商品相同的 matched_group_id。
    5. 排除不相關配件。
    """

    # 針對 high demand 自動重試 3 次
    for attempt in range(3):
        try:
            response = client.models.generate_content(
                model="gemini-2.5-flash",
                contents=prompt,
                config={
                    "response_mime_type": "application/json",
                    "response_schema": ComparisonResult,
                },
            )
            raw_json = json.loads(response.text)
            result = ComparisonResult.model_validate(raw_json)
            return result.items
        except APIError as e:
            if "high demand" in str(e).lower() or attempt < 2:
                time.sleep(3 * (attempt + 1))
                continue
            raise e
        except Exception:
            # 備用降級呼叫
            response = client.models.generate_content(
                model="gemini-2.5-flash-lite",
                contents=prompt,
                config={
                    "response_mime_type": "application/json",
                    "response_schema": ComparisonResult,
                },
            )
            return ComparisonResult.model_validate(json.loads(response.text)).items
    return []
