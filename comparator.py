import os
import json
import urllib.parse
import httpx
from bs4 import BeautifulSoup
from google import genai
from pydantic import BaseModel, Field

# 初始化 Gemini Client
client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))

class ProductItem(BaseModel):
    store_name: str = Field(description="購物網站名稱")
    raw_title: str = Field(description="商城原始商品標題")
    canonical_name: str = Field(description="歸一化後的標準商品品名")
    price: float = Field(description="商品數值價格，排除所有符號")
    currency: str = Field(default="TWD", description="幣別")
    matched_group_id: str = Field(description="相同規格的群組 ID，例如 iphone-15-128gb")
    key_specs: dict[str, str] = Field(description="規格鍵值對，如容量、RAM、顏色、型號")
    is_target_match: bool = Field(description="是否與使用者輸入意圖吻合")

def fetch_page_text(url: str) -> str:
    """抓取網頁純文字，過濾雜訊降低 Token 消耗"""
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    try:
        with httpx.Client(timeout=10.0, follow_redirects=True) as http_client:
            res = http_client.get(url, headers=headers)
            if res.status_code != 200:
                return ""
            soup = BeautifulSoup(res.text, "html.parser")
            for tag in soup(["script", "style", "nav", "footer", "header", "noscript"]):
                tag.decompose()
            # 截取前 4000 字元避免超過單次搜尋結果的有效長度
            text = " ".join(soup.stripped_strings)
            return text[:4000]
    except Exception as e:
        return f"抓取失敗: {str(e)}"

def run_price_comparison(keyword: str, stores: list[dict]) -> list[ProductItem]:
    collected_data = []
    
    for store in stores:
        search_url = store["search_template"].format(keyword=urllib.parse.quote(keyword))
        page_text = fetch_page_text(search_url)
        if page_text and not page_text.startswith("抓取失敗"):
            collected_data.append({
                "store_name": store["name"],
                "content": page_text
            })

    if not collected_data:
        return []

    prompt = f"""
    使用者正在搜尋關鍵字："{keyword}"。
    
    以下是從各電商抓取到的原始搜尋結果摘要：
    {json.dumps(collected_data, ensure_ascii=False)}

    任務需求：
    1. 從每個商城中提取與關鍵字最相關的前 2~3 個商品。
    2. 提取出乾淨的價格（純數字）。
    3. 解析詳細規格（如儲存空間、處理器、尺寸、型號）。
    4. 將「實體規格完全相同/對等」的商品指定相同的 matched_group_id。
    5. 過濾掉配件、不相關推薦或缺貨項目（標記 is_target_match = false）。
    """

    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=prompt,
        config={
            "response_mime_type": "application/json",
            "response_schema": list[ProductItem],
        },
    )
    return response.parsed
