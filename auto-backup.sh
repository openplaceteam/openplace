#!/bin/bash

# Script de ejemplo para backups automáticos de OpenPlace
# Este script puede ser ejecutado manualmente o configurado en cron

set -e

# Directorio del proyecto OpenPlace
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

# Colores
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${GREEN}=== OpenPlace - Backup Automático ===${NC}"
echo -e "Fecha: $(date)"
echo ""

# 1. Crear backup completo
echo -e "${YELLOW}Creando backup completo...${NC}"
./manage.sh backup-full

# 2. Rotar backups antiguos (mantener últimos 7)
echo -e "${YELLOW}Rotando backups antiguos...${NC}"
cd backups/
BACKUP_COUNT=$(ls -1 openplace_full_*.tar.gz 2>/dev/null | wc -l)
if [ "$BACKUP_COUNT" -gt 7 ]; then
    DELETED=$(ls -t openplace_full_*.tar.gz | tail -n +8 | wc -l)
    ls -t openplace_full_*.tar.gz | tail -n +8 | xargs rm -f
    echo -e "${GREEN}✓ Eliminados $DELETED backups antiguos${NC}"
else
    echo -e "${BLUE}ℹ Solo hay $BACKUP_COUNT backups, no es necesario rotar${NC}"
fi
cd ..

# 3. Opcional: Subir a almacenamiento remoto
# Descomenta y configura según tu necesidad

# Ejemplo con rclone (requiere configuración previa)
# echo -e "${YELLOW}Sincronizando con almacenamiento remoto...${NC}"
# rclone copy backups/ remote:openplace-backups/ --progress
# echo -e "${GREEN}✓ Backups sincronizados${NC}"

# Ejemplo con rsync a otro servidor
# echo -e "${YELLOW}Copiando a servidor de backups...${NC}"
# rsync -avz backups/ usuario@servidor-backup:/ruta/backups/openplace/
# echo -e "${GREEN}✓ Backups copiados${NC}"

# Ejemplo con scp
# echo -e "${YELLOW}Copiando a servidor de backups...${NC}"
# scp backups/openplace_full_$(date +%Y%m%d)*.tar.gz usuario@servidor-backup:/backups/
# echo -e "${GREEN}✓ Backup copiado${NC}"

# 4. Mostrar resumen
echo ""
echo -e "${GREEN}=== Resumen de Backups ===${NC}"
echo -e "Total de backups completos: $(ls -1 backups/openplace_full_*.tar.gz 2>/dev/null | wc -l)"
echo -e "Total de backups de DB: $(ls -1 backups/openplace_db_*.sql.gz 2>/dev/null | wc -l)"
echo -e "Espacio usado: $(du -sh backups/ | cut -f1)"
echo ""
echo -e "${BLUE}Últimos 3 backups:${NC}"
ls -lht backups/openplace_full_*.tar.gz 2>/dev/null | head -3 || echo "No hay backups completos"
echo ""
echo -e "${GREEN}✓ Backup automático completado${NC}"
