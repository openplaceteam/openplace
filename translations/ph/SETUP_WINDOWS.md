# OpenPlace — Windows Setup Guide

Ang gabay ito ay makatutulong para inihanda ang **Windows** ng kompyuter na magsetup sa **openplace**.

---

## 1. Ang kinakailangan

Kailangan ka ng **Node.js**, **Git**, **MariaDB**, **Caddy**.

- I-run ang **winget** (Windows 10/11 PowerShell as Administrator):

```powershell
winget install Git.Git
winget install OpenJS.NodeJS.LTS
winget install CaddyServer.Caddy
winget install nssm
```

- I-run ang **Chocolatey** (cmd as Administrator):

```cmd
choco install git nodejs-lts caddy nssm -y
```

- I-download ang MariaDB Server sa link ito: [MariaDB Server](https://mirror.mva-n.net/mariadb///mariadb-12.0.2/winx64-packages/mariadb-12.0.2-winx64.msi)
- I-run ang installer
- Itakda ang root password at panatilihin itong pareho
  
---

## 2. I-clone ang repository

```powershell
git clone --recurse-submodules https://github.com/openplaceteam/openplace
cd openplace
```

---

## 3. Mag-install ng Node dependencies

```powershell
npm install
npm install -g pm2
```

---

## 4 Itigil ang Caddy services (kailangan ito kung na-install ito bilang serbisyo)

- Kung na-install ang Caddy bilang serbisyo, tigilan ito sa pamamagitan ng **Services.msc**  
- O mano-mano:

```powershell
net stop caddy
```

---

## 5. I-configure at magpagawa ng database

1. Kopyahin ang`.env.example` sa `.env`:

```powershell
Copy-Item .env.example .env
```

I-edit ang `.env` at palitan ang `root:password` ng inyong MariaDB root password at palitan ang`JWT_SECRET`.

> [BABALA ⚠️]
> Escape special character listed in this table: [Percent-Encoding](https://developer.mozilla.org/en-US/docs/Glossary/Percent-encoding)

---

## 6. I-setup ang Prisma at database

```powershell
npm run db:generate
npm run setup
```

---

## 7.A I-Run ang server sa sarili

run frontend in one terminal: 
```powershell
npm run dev
```
run caddy in a second terminal:
```powershell
caddy run --config .\Caddyfile
```

---

## 7.B Run ang dalawang command sa terminal

```cmd
npm run exec
```

## 7.C I-Run ang Caddy sa background at ang node sa foreground

```
pm2 start ecosystem.config.cjs
pm2 save
```


---

## Magpagawa ng inyong server

- Kung gagawin itong pampubliko, magconfigure ngSSL certificate.  
- Para sa inyong sarili, pumunta sa:

```
https://{your-local-IP}:8080
```

> [BABALA ⚠️]
> ⚠️ **Important:** Ang OpenPlace ay gumagana lamang sa HTTPS. Kapag gumagamit ka ng HTTP, magkaroon ka ng **400 Bad Request**.


---

## Mag-update sa database

Kapag may nagbabago sa schema, i-run ang:

```powershell
npm run db:push
```
