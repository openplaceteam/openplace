# openplace

<p align="center"><strong>Translations</strong></p>
<p align="center">
	<a href="../translations/ph/README.md"><img src="https://flagcdn.com/256x192/ph.png" width="48" alt="Filipino Flag"></a>
    <a href="../translations/id/README.md"><img src="https://flagcdn.com/256x192/id.png" width="48" alt="Indonesia Flag"></a>
    <a href="translations/fr/LISEZMOI.md"><img src="https://flagcdn.com/256x192/fr.png" width="48" alt="French Flag"></a>
  &nbsp;


## 

Openplace (styled lowercase) is a free unofficial open source backend for [wplace.](https://wplace.live) We aim to give the freedom and flexibility for all users to be able to make their own private wplace experience for themselves, their friends, or even their community.

> [WARNING ⚠️]
> This is a work-in-progress. Expect unfinished features and bugs. Please help us by posting issues in #tech-support on our [Discord server](https://discord.gg/ZRC4DnP9Z2) or by contributing pull requests. Thanks!

## Getting Started

### Windows

- [Guideline for Windows Installation](translations/en/SETUP_WINDOWS.md)

### macOS

- [Guideline for macOS Installation](translations/en/SETUP_MACOS.md)

### Docker

- [Guideline for Docker Installation](translations/en/SETUP_DOCKER.md)


### Server accessibility
You will be required to configure an SSL certificate if you plan to use this in production. However, if you are only using this with you and your friends, you can simply navigate to `https://{IP}:8080` NOTE: openplace is only hosted over HTTPS. you will run into HTTP error 400 if you attempt to load the website over HTTP.

### Updating your database
In the event that the database schematic changes, you simply need to run `npm run db:push` to update your database schema.

## License
Licensed under the Apache License, version 2.0. Refer to [LICENSE.md](https://github.com/openplaceteam/openplace/blob/main/LICENSE.md).

### Acknowledgements
Region data is from [GeoNames Gazetteer](https://download.geonames.org/export/dump/), and is licensed under a [Creative Commons Attribution 4.0 License](https://creativecommons.org/licenses/by/4.0/). The Data is provided “as is” without warranty or any representation of accuracy, timeliness or completeness.
