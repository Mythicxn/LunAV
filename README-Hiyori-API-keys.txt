Bước 1 - Cài đặt API key cho Hiyori

Đã thêm trong Cài đặt:
- Google Gemini API: nhập key, kiểm tra trước rồi mới thay key cũ; xoá key bằng nút Xoá key.
- Tavily Web Search: nhập key, kiểm tra trước rồi mới thay key cũ; xoá key bằng nút Xoá key.

Credential được lưu trong %APPDATA% của Hiyori bằng safeStorage, không ghi key mới vào cai-dat.json.

Tương thích bản cũ:
- Gemini key cũ trong key.txt được chuyển sang kho mã hoá khi safeStorage khả dụng.
- Tavily key cũ trong cai-dat.json được chuyển sang kho mã hoá khi safeStorage khả dụng và bản plaintext được xoá khỏi cai-dat.json.

Lưu ý Tavily:
- Kiểm tra key thực sự gọi endpoint search của Tavily 1 lần; request kiểm tra có thể tiêu credit.
- Hiyori vẫn ưu tiên DuckDuckGo miễn phí; Tavily chỉ fallback khi DuckDuckGo lỗi/rỗng.

Không chép model hoặc cai-dat.json vào bản phát hành này.
