# Getting Started with OpenPlace (macOS)

Ang gabay ito ay makatutulong para inihanda ang **macOS** ng kompyuter na magsetup sa **OpenPlace**.

---

## Step 1: Mag-install sa kinakailangan
Kailangan ka ng na-install ang kinakailangan sa inyong system:
- **Homebrew**
- **Node.js**
- **Git**

---

## Step 2: I-clone ang repository
```bash
git clone --recurse-submodules https://github.com/openplaceteam/openplace
cd openplace
```

---

## Step 3: Mag-install ng Node dependencies
```bash
npm i && brew install mariadb caddy nss
```
Kapag ang brew ay hindi magsimula ng serbisyo ng awtomatiko, i-run:
```bash
brew services start mariadb
brew services start caddy
```

---

## Step 4: I-configure at magpagawa ng database

I-run ang secure installation script para sa MySQL:
```bash
sudo mysql_secure_installation
```

Sundin kung ano ang ipinapakita:
1. Pindutin ng **Enter** para sa kasalukuyang root password.
2. Pindutin ng **`n`** kapag tinanong ka na mag-switch sa unix_socket authentication.
3. Pindutin ng **`y`** kapag tinanong ka na ibabago ang root password.  
   ⚠️ **Huwag** gumamit ng "password" na ipinakita sa demo ito.
4. Pindutin ng **`y`** para tanggalin ang anonymous users.
5. Pumili ka kung hindi pwede magkaroon ng remote root logins (**recommended: y**).
6. Pindutin ng **`y`** para tanggalin ang test database.
7. Pindutin ng **`y`** para magreload ng configuration.

Sunod, i-configure ang environment:
```bash
cp .env.example .env
```
I-update ang `.env` file sa inyong piniling MySQL password.

---

## Step 5: I-setup ang Database

I-run ang mga Prisma commands:
```bash
npm run db:generate
npm run setup
```

---

## Step 6: Mag-run sa applikasyon

I-run ang dev server:
```bash
npm run dev
```

Sa ibang terminal, i-run ang Caddy:
```bash
caddy run --config Caddyfile
```

---

## Tandaan para sa SSL
Ang OpenPlace ay **kailangan ng HTTPS**.  
Kung nagsusubok ka sa pansarili, pwede mag-access ang app sa:
```
https://{IP}:8080
```
⚠️ Kapag gumagamit ka ng HTTP, magkaroon ito ng **HTTP 400 error**.

---

## Mag-update sa database

Kapag may nagbabago sa database schema, i-run ang:
```bash
npm run db:push
```
