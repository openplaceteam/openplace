#!/bin/bash

# Script de gestión para OpenPlace en servidor remoto
# Proporciona comandos útiles para administrar el despliegue

SERVER_IP="192.168.1.16"
SERVER_USER="root"
REMOTE_DIR="/opt/openplace"

# Colores
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

show_help() {
    echo -e "${GREEN}OpenPlace - Script de Gestión${NC}"
    echo ""
    echo "Uso: ./manage.sh [comando]"
    echo ""
    echo "Comandos disponibles:"
    echo "  ${YELLOW}logs${NC}         - Ver logs en tiempo real de todos los servicios"
    echo "  ${YELLOW}logs-app${NC}     - Ver logs solo del backend (app)"
    echo "  ${YELLOW}logs-db${NC}      - Ver logs solo de la base de datos"
    echo "  ${YELLOW}logs-caddy${NC}   - Ver logs solo del servidor web"
    echo "  ${YELLOW}status${NC}       - Ver estado de los contenedores"
    echo "  ${YELLOW}restart${NC}      - Reiniciar todos los servicios"
    echo "  ${YELLOW}restart-app${NC}  - Reiniciar solo el backend"
    echo "  ${YELLOW}stop${NC}         - Detener todos los servicios"
    echo "  ${YELLOW}start${NC}        - Iniciar todos los servicios"
    echo "  ${YELLOW}redeploy${NC}     - Copiar archivos locales y reiniciar"
    echo "  ${YELLOW}backup${NC}       - Crear copia de seguridad de la base de datos"
    echo "  ${YELLOW}backup-full${NC}  - Copia de seguridad completa (DB + archivos)"
    echo "  ${YELLOW}shell${NC}        - Conectarse al servidor via SSH"
    echo "  ${YELLOW}shell-app${NC}    - Abrir shell en el contenedor de la app"
    echo "  ${YELLOW}db-shell${NC}     - Abrir shell de MariaDB"
    echo "  ${YELLOW}clean${NC}        - Detener y limpiar todos los contenedores"
    echo ""
}

remote_exec() {
    ssh -o StrictHostKeyChecking=no "$SERVER_USER@$SERVER_IP" "$@"
}

case "$1" in
    logs)
        echo -e "${BLUE}Mostrando logs en tiempo real (Ctrl+C para salir)${NC}"
        remote_exec "cd $REMOTE_DIR && docker compose logs -f"
        ;;
    logs-app)
        echo -e "${BLUE}Mostrando logs del backend (Ctrl+C para salir)${NC}"
        remote_exec "cd $REMOTE_DIR && docker compose logs -f app"
        ;;
    logs-db)
        echo -e "${BLUE}Mostrando logs de la base de datos (Ctrl+C para salir)${NC}"
        remote_exec "cd $REMOTE_DIR && docker compose logs -f db"
        ;;
    logs-caddy)
        echo -e "${BLUE}Mostrando logs del servidor web (Ctrl+C para salir)${NC}"
        remote_exec "cd $REMOTE_DIR && docker compose logs -f caddy"
        ;;
    status)
        echo -e "${BLUE}Estado de los contenedores:${NC}"
        remote_exec "cd $REMOTE_DIR && docker compose ps"
        ;;
    restart)
        echo -e "${YELLOW}Reiniciando todos los servicios...${NC}"
        remote_exec "cd $REMOTE_DIR && docker compose restart"
        echo -e "${GREEN}✓ Servicios reiniciados${NC}"
        ;;
    restart-app)
        echo -e "${YELLOW}Reiniciando backend...${NC}"
        remote_exec "cd $REMOTE_DIR && docker compose restart app"
        echo -e "${GREEN}✓ Backend reiniciado${NC}"
        ;;
    stop)
        echo -e "${YELLOW}Deteniendo todos los servicios...${NC}"
        remote_exec "cd $REMOTE_DIR && docker compose down"
        echo -e "${GREEN}✓ Servicios detenidos${NC}"
        ;;
    start)
        echo -e "${YELLOW}Iniciando todos los servicios...${NC}"
        remote_exec "cd $REMOTE_DIR && docker compose up -d"
        echo -e "${GREEN}✓ Servicios iniciados${NC}"
        ;;
    redeploy)
        echo -e "${YELLOW}Copiando archivos locales al servidor...${NC}"
        LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"

        # Verificar que el submódulo frontend está inicializado
        if [ ! -f "$LOCAL_DIR/frontend/404.html" ]; then
            echo -e "${YELLOW}Inicializando submódulo frontend...${NC}"
            cd "$LOCAL_DIR"
            git submodule update --init --recursive
            cd - > /dev/null
        fi

        # Crear tar temporal
        tar -czf /tmp/openplace-redeploy.tar.gz \
            --exclude='node_modules' \
            --exclude='.git' \
            --exclude='dist' \
            --exclude='.env' \
            --exclude='*.log' \
            -C "$LOCAL_DIR" .

        # Copiar al servidor
        scp -o StrictHostKeyChecking=no /tmp/openplace-redeploy.tar.gz "$SERVER_USER@$SERVER_IP:/tmp/"

        # Extraer y reiniciar
        remote_exec "
            cd $REMOTE_DIR
            tar -xzf /tmp/openplace-redeploy.tar.gz
            rm /tmp/openplace-redeploy.tar.gz
            docker compose restart app
        "

        rm /tmp/openplace-redeploy.tar.gz
        echo -e "${GREEN}✓ Archivos actualizados y servicios reiniciados${NC}"
        ;;
    shell)
        echo -e "${BLUE}Conectando al servidor...${NC}"
        ssh "$SERVER_USER@$SERVER_IP"
        ;;
    shell-app)
        echo -e "${BLUE}Abriendo shell en el contenedor de la app...${NC}"
        remote_exec "cd $REMOTE_DIR && docker compose exec app sh"
        ;;
    db-shell)
        echo -e "${BLUE}Abriendo shell de MariaDB...${NC}"
        echo -e "${YELLOW}Contraseña: password${NC}"
        remote_exec "cd $REMOTE_DIR && docker compose exec db mariadb -uroot -p openplace"
        ;;
    backup)
        echo -e "${YELLOW}Creando copia de seguridad de la base de datos...${NC}"
        BACKUP_DIR="./backups"
        mkdir -p "$BACKUP_DIR"

        TIMESTAMP=$(date +%Y%m%d_%H%M%S)
        BACKUP_FILE="$BACKUP_DIR/openplace_db_${TIMESTAMP}.sql"

        echo -e "${BLUE}Exportando base de datos...${NC}"
        remote_exec "cd $REMOTE_DIR && docker compose exec -T db mariadb-dump -uroot -ppassword openplace" > "$BACKUP_FILE"

        if [ -s "$BACKUP_FILE" ]; then
            # Comprimir el backup
            gzip "$BACKUP_FILE"
            BACKUP_SIZE=$(ls -lh "${BACKUP_FILE}.gz" | awk '{print $5}')
            echo -e "${GREEN}✓ Backup creado exitosamente${NC}"
            echo -e "  Archivo: ${BLUE}${BACKUP_FILE}.gz${NC}"
            echo -e "  Tamaño: ${BLUE}${BACKUP_SIZE}${NC}"
            echo -e "  Fecha: ${BLUE}$(date)${NC}"
        else
            echo -e "${RED}Error: No se pudo crear el backup${NC}"
            rm -f "$BACKUP_FILE"
            exit 1
        fi
        ;;
    backup-full)
        echo -e "${YELLOW}Creando copia de seguridad completa...${NC}"
        BACKUP_DIR="./backups"
        mkdir -p "$BACKUP_DIR"

        TIMESTAMP=$(date +%Y%m%d_%H%M%S)
        BACKUP_DB_FILE="$BACKUP_DIR/openplace_db_${TIMESTAMP}.sql"
        BACKUP_FULL_FILE="$BACKUP_DIR/openplace_full_${TIMESTAMP}.tar.gz"

        # 1. Backup de la base de datos
        echo -e "${BLUE}[1/3] Exportando base de datos...${NC}"
        remote_exec "cd $REMOTE_DIR && docker compose exec -T db mariadb-dump -uroot -ppassword openplace" > "$BACKUP_DB_FILE"

        if [ ! -s "$BACKUP_DB_FILE" ]; then
            echo -e "${RED}Error: No se pudo exportar la base de datos${NC}"
            rm -f "$BACKUP_DB_FILE"
            exit 1
        fi

        # 2. Descargar archivos del servidor
        echo -e "${BLUE}[2/3] Descargando archivos del servidor...${NC}"
        TEMP_DIR=$(mktemp -d)

        # Descargar .env
        scp -o StrictHostKeyChecking=no "$SERVER_USER@$SERVER_IP:$REMOTE_DIR/.env" "$TEMP_DIR/" 2>/dev/null || echo "No se encontró .env"

        # Descargar archivos subidos (si existen)
        remote_exec "cd $REMOTE_DIR && tar -czf /tmp/openplace_files.tar.gz --exclude='node_modules' --exclude='.git' --exclude='dist' *.json *.yml *.yaml Caddyfile 2>/dev/null || true"
        scp -o StrictHostKeyChecking=no "$SERVER_USER@$SERVER_IP:/tmp/openplace_files.tar.gz" "$TEMP_DIR/" 2>/dev/null || true
        remote_exec "rm -f /tmp/openplace_files.tar.gz"

        # 3. Crear archivo de backup completo
        echo -e "${BLUE}[3/3] Creando archivo de backup completo...${NC}"
        tar -czf "$BACKUP_FULL_FILE" -C "$BACKUP_DIR" "openplace_db_${TIMESTAMP}.sql" -C "$TEMP_DIR" . 2>/dev/null

        # Limpiar archivos temporales
        rm -rf "$TEMP_DIR"
        rm -f "$BACKUP_DB_FILE"

        if [ -s "$BACKUP_FULL_FILE" ]; then
            BACKUP_SIZE=$(ls -lh "$BACKUP_FULL_FILE" | awk '{print $5}')
            echo -e "${GREEN}✓ Backup completo creado exitosamente${NC}"
            echo -e "  Archivo: ${BLUE}${BACKUP_FULL_FILE}${NC}"
            echo -e "  Tamaño: ${BLUE}${BACKUP_SIZE}${NC}"
            echo -e "  Fecha: ${BLUE}$(date)${NC}"
            echo ""
            echo -e "${YELLOW}Contenido del backup:${NC}"
            echo -e "  • Base de datos completa"
            echo -e "  • Archivo .env"
            echo -e "  • Archivos de configuración"
        else
            echo -e "${RED}Error: No se pudo crear el backup completo${NC}"
            exit 1
        fi
        ;;
    clean)
        echo -e "${YELLOW}¿Estás seguro? Esto eliminará todos los contenedores y volúmenes. (y/n)${NC}"
        read -r response
        if [[ "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
            echo -e "${YELLOW}Limpiando...${NC}"
            remote_exec "cd $REMOTE_DIR && docker compose down -v"
            echo -e "${GREEN}✓ Contenedores y volúmenes eliminados${NC}"
        else
            echo "Operación cancelada"
        fi
        ;;
    *)
        show_help
        ;;
esac
