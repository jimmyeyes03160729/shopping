import streamlit as st

st.set_page_config(page_title="個人智慧比價系統", layout="wide")
st.title("個人智慧比價系統")
st.info(
    "此專案目前以 GitHub Pages / Cloudflare Worker 版本為主。"
    "請依 README 部署 Worker，前端會透過 /api/search 取得比價結果。"
)
st.markdown("### 操作方式")
st.markdown(
    "1. 輸入主商品名稱，例如 **iPhone 18 Pro**\n"
    "2. 系統自動列出容量、顏色等規格\n"
    "3. 點選規格後比較各商城同規格價格"
)
