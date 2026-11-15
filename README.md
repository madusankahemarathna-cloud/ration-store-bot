# 🤖 Ration Store Free WhatsApp Automation Service
### 100% Free Baileys Multi-Device Engine + Firebase Firestore

This backend service runs 24/7, connects to WhatsApp via `@whiskeysockets/baileys` (zero Meta/Twilio API fees), queries Firebase Firestore daily at **08:00 AM (Asia/Colombo)**, sends expiry notifications, and handles two-way **YES / NO** responses.

---

## 📋 Features
1. **Free WhatsApp Web Multi-Device Pairing:** Pair any phone number via QR code once (`http://localhost:4000/qr`). Session persists in `auth_info_baileys`.
2. **Automated Daily Audit:** Scheduled via `node-cron` at 08:00 AM (`Asia/Colombo`).
3. **Milestone Alerts:** Sends alert when any batch reaches exactly **30 Days**, **7 Days**, or **3 Days or less** before expiry:
   > *"⚠️ EXPIRY ALERT: [Item Name] (Exp: [YYYY-MM-DD]) expires in [X] days. Still in stock? Reply YES to keep, or NO to remove."*
4. **Interactive Two-Way Auto-Deletion:**
   - Storekeeper replies **"NO"** &rarr; The specific batch document is **automatically deleted** from Firestore `stock_batches` collection. Master item & permanent QR code remain intact.
   - Storekeeper replies **"YES"** &rarr; Batch remains active in store tracking.

---

## 🚀 Setup & Local Execution

### 1. Install Dependencies
```bash
cd whatsapp-service
npm install
```

### 2. Configure Firebase Admin Credentials
1. Go to [Firebase Console](https://console.firebase.google.com/) &rarr; Project Settings &rarr; **Service accounts**.
2. Click **Generate new private key** and download the `.json` file.
3. Rename the file to `serviceAccountKey.json` and place it in the `whatsapp-service/` folder.

### 3. Run the Service
```bash
npm start
```
- Web Dashboard: `http://localhost:4000`
- Pair WhatsApp: `http://localhost:4000/qr` (Scan from phone via **WhatsApp &rarr; Linked Devices &rarr; Link a Device**).

---

## ☁️ Free Cloud Deployment (Render.com / Koyeb)

You can run this service 24/7 on the cloud for **$0/month**:

### Deploying to Render.com (Free Web Service)
1. Push this code to your GitHub repository.
2. In [Render Dashboard](https://dashboard.render.com/), click **New +** &rarr; **Web Service**.
3. Select your repository and set:
   - **Root Directory:** `whatsapp-service`
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
4. In **Environment Variables**:
   - `PORT`: `4000`
   - `FIREBASE_SERVICE_ACCOUNT`: Copy the entire text content of your `serviceAccountKey.json` and paste it here as a single-line string.
5. Deploy! Open the Render URL + `/qr` to pair your WhatsApp number.
