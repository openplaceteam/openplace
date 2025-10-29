# openplace

<p align="center"><strong>Translations</strong></p>
<p align="center">
	<a href="../../README.md"><img src="https://flagcdn.com/256x192/us.png" width="48" alt="United States Flag"></a>
    <a href="../id/README.md"><img src="https://flagcdn.com/256x192/id.png" width="48" alt="Indonesia Flag"></a>
    <a href="../fr/LISEZMOI.md"><img src="https://flagcdn.com/256x192/fr.png" width="48" alt="French Flag"></a>
  &nbsp;

## 

Ang Openplace (guhit ng maikli) ay isang libre, hindi-opisyal, "open source backend" para sa [wplace.](https://wplace.live) Ang aming layunin ay magbigay ng kalayaan at kakayahang umangkop para sa lahat ng mga tao ng iginawa ng sariling "wplace experience" para sa kanilang sarili, sa kaibigan, o maging ang kanilang  komunidad.

> [BABALA ⚠️]
> Ito ay isang ginagawang trabaho. Aasahan ng may hindi tinatapos ng parte sa program at may mali. Maaaring magtutulong sa pamamagitan ng magpost ng issues sa #tech-support sa ating [Discord server](https://discord.gg/ZRC4DnP9Z2) o kaya magcontribute ng "pull requests". Maraming salamat!!

## Magsisimula:

### Windows

- [Gabay para sa Windows Installation](translations/ph/SETUP_WINDOWS.md)

### macOS

- [Gabay para sa macOS Installation](translations/ph/SETUP_MACOS.md)

### Docker

- [Gabay para sa Docker Installation](translations/ph/SETUP_DOCKER.md)


### Access sa Server
Kinakailangan ng mag-configure ng SSL certificate kung gagawin itong pampubliko. Gayunpaman, kung ikaw ay ginagamit ng para sa sarili at mga kaibigan lamang, maaari kang pumunta sa `https://{IP}:8080` TANDAAN: Ang openplace ay nagho-host sa HTTPS lamang. Magkaroon ka ng HTTP error 400 kung magloload ka sa website sa HTTP.

### Mag-update sa database
Kapag may nagbabago sa database schematic, maaaring i-run ang `npm run db:push` para i-update ang inyong database schema.

## Licensya
Lisensyado it sa Apache License, version 2.0. Sumangguni sa [LICENSE.md](https://github.com/openplaceteam/openplace/blob/main/LICENSE.md).

### Mga Pasasalamat
Ang mga datos sa rehiyon ay mula sa [GeoNames Gazetteer](https://download.geonames.org/export/dump/), at lisensyado ito sa [Creative Commons Attribution 4.0 License](https://creativecommons.org/licenses/by/4.0/). Ang Datos ito ay ibinigay “as is” ng walang warranty o representasyon ng katumpakan, pagiging napapanahon or pagkakumpleto.