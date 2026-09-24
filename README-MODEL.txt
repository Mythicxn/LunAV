HƯỚNG DẪN ĐỔI MODEL LIVE2D

Project tự quét các thư mục con trong models/.
Mỗi model chỉ cần có một file *.model3.json trong thư mục riêng.

Ví dụ:
  models/hiyori/Hiyori.model3.json
  models/vanilla/vanilla.model3.json

Model đang dùng được lưu ở:
  cai-dat.json -> "live2dModel": "vanilla"

CÁCH ĐỔI MODEL:
1. Mở app -> Cài đặt (⚙).
2. Ở mục "Model Live2D", chọn model muốn dùng.
3. Model được tải ngay và lựa chọn được lưu tự động.

KHI THÊM MODEL MỚI:
1. Tạo thư mục models/<ten-model>/
2. Giải nén toàn bộ bộ model vào đó.
3. Đảm bảo có file *.model3.json và các file được tham chiếu bên trong file đó.
4. Khởi động lại app nếu model mới chưa xuất hiện trong danh sách.

Không cần sửa đường dẫn trong renderer.js nữa.
