import os
import json
import streamlit as st
import pandas as pd
from dotenv import load_dotenv
from comparator import run_price_comparison

load_dotenv()

st.set_page_config(page_title="AI 電商比價系統", layout="wide")

STORES_FILE = "stores.json"

def load_stores():
    if os.path.exists(STORES_FILE):
        with open(STORES_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return []

def save_stores(stores):
    with open(STORES_FILE, "w", encoding="utf-8") as f:
        json.dump(stores, f, ensure_ascii=False, indent=2)

st.title(" 智慧多商城比價系統 (Gemini 驅動)")

# 側邊欄：商城清單管理
st.sidebar.header(" 商城清單管理")
stores = load_stores()

with st.sidebar.expander("新增商城網址", expanded=False):
    new_name = st.text_input("商城名稱 (如: 蝦皮購物)")
    new_url = st.text_input("搜尋網址模板 (使用 {keyword})", placeholder="https://example.com/search?q={keyword}")
    if st.button("新增商城"):
        if new_name and "{keyword}" in new_url:
            stores.append({"name": new_name, "search_template": new_url})
            save_stores(stores)
            st.success(f"已新增 {new_name}")
            st.rerun()
        else:
            st.error("請確認名稱填寫正確，且網址中包含 {keyword}")

st.sidebar.write("目前追蹤中的商城：")
for idx, s in enumerate(stores):
    col_name, col_del = st.sidebar.columns([4, 1])
    col_name.write(f"- {s['name']}")
    if col_del.button("刪除", key=f"del_{idx}"):
        stores.pop(idx)
        save_stores(stores)
        st.rerun()

# 主畫面：比價搜尋
keyword = st.text_input("請輸入想搜尋的比價商品關鍵字", placeholder="例如：iPhone 15 128G、Sony WH-1000XM5")

if st.button("開始跨平台比價", type="primary"):
    if not os.environ.get("GEMINI_API_KEY"):
        st.error("請先設定 GEMINI_API_KEY 環境變數！")
    elif not keyword.strip():
        st.warning("請輸入搜尋關鍵字")
    elif not stores:
        st.warning("目前沒有設定任何購物官網，請由側邊欄新增")
    else:
        with st.spinner("正在爬取並交由 Gemini 進行規格比對..."):
            try:
                results = run_price_comparison(keyword, stores)
                valid_items = [item for item in results if item.is_target_match]
                
                if not valid_items:
                    st.info("未找到符合規格的商品。")
                else:
                    df = pd.DataFrame([{
                        "比對組別": item.matched_group_id,
                        "商城": item.store_name,
                        "商品名稱": item.canonical_name,
                        "價格": item.price,
                        "幣別": item.currency,
                        "核心規格": str(item.key_specs),
                        "原始標題": item.raw_title
                    } for item in valid_items])
                    
                    df = df.sort_values(by=["比對組別", "價格"], ascending=[True, True])
                    
                    st.subheader(" 比價結果清單 (同規格已分組排序)")
                    st.dataframe(df, use_container_width=True)
            except Exception as e:
                st.error(f"執行時發生錯誤：{str(e)}")
