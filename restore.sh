#!/bin/bash

# Script de restauración para OpenPlace
# Permite restaurar un backup en cualquier servidor

set -e

# Colores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${GREEN}=== OpenPlace - Script de Restauración ===${NC}\n"

# Función para mostrar ayuda
show_help() {
    echo "Uso: ./restore.sh [opciones]"
    echo ""
    echo "Opciones:"
    echo "  -h, --help              Mostrar esta ayuda"
    echo "  -f, --file FILE         Archivo de backup a restaurar (requerido)"
    echo "  -s, --server IP         IP del servidor (se pedirá si no se especifica)"
    echo "  -u, --user USER         Usuario SSH (se pedirá si no se especifica)"
    echo "  -p, --password PASS     Contraseña SSH (se pedirá si no se especifica)"
    echo "  -d, --dir DIR           Directorio remoto (default: /opt/openplace)"
    echo "  --db-only               Solo restaurar base de datos"
    echo ""
    echo "Ejemplos:"
    echo "  ./restore.sh -f backups/openplace_db_20251006_120000.sql.gz"
    echo "  ./restore.sh -f backups/openplace_full_20251006_120000.tar.gz -s 192.168.1.16"
    echo "  ./restore.sh --file backup.sql.gz --server 192.168.1.16 --user root"
    exit 0
}

# Variables
BACKUP_FILE=""
SERVER_IP=""
SERVER_USER=""
SERVER_PASSWORD=""
REMOTE_DIR="/opt/openplace"
DB_ONLY=false
USE_SSH_KEY=false

# Parsear argumentos
while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_help
            ;;
        -f|--file)
            BACKUP_FILE="$2"
            shift 2
            ;;
        -s|--server)
            SERVER_IP="$2"
            shift 2
            ;;
        -u|--user)
            SERVER_USER="$2"
            shift 2
            ;;
        -p|--password)
            SERVER_PASSWORD="$2"
            shift 2
            ;;
        -d|--dir)
            REMOTE_DIR="$2"
            shift 2
            ;;
        --db-only)
            DB_ONLY=true
            shift
            ;;
        *)
            echo -e "${RED}Error: Opción desconocida: $1${NC}"
            echo "Usa --help para ver las opciones disponibles"
            exit 1
            ;;
    esac
done

# Verificar que se especificó un archivo de backup
if [ -z "$BACKUP_FILE" ]; then
    echo -e "${RED}Error: Debes especificar un archivo de backup con -f o --file${NC}"
    echo "Usa --help para ver las opciones disponibles"
    exit 1
fi

# Verificar que el archivo existe
if [ ! -f "$BACKUP_FILE" ]; then
    echo -e "${RED}Error: El archivo de backup no existe: $BACKUP_FILE${NC}"
    exit 1
fi

# Solicitar información del servidor si no se proporcionó
if [ -z "$SERVER_IP" ]; then
    echo -e "${YELLOW}Introduce la IP del servidor:${NC}"
    read -r SERVER_IP
fi

if [ -z "$SERVER_USER" ]; then
    echo -e "${YELLOW}Introduce el usuario SSH (default: root):${NC}"
    read -r SERVER_USER
    SERVER_USER=${SERVER_USER:-root}
fi

# Verificar si se puede usar clave SSH
if ssh -o BatchMode=yes -o ConnectTimeout=5 "$SERVER_USER@$SERVER_IP" exit 2>/dev/null; then
    USE_SSH_KEY=true
    echo -e "${GREEN}✓ Autenticación con clave SSH disponible${NC}"
else
    # Solicitar contraseña
    if [ -z "$SERVER_PASSWORD" ]; then
        echo -e "${YELLOW}Introduce la contraseña SSH:${NC}"
        read -s SERVER_PASSWORD
        echo ""
    fi

    # Verificar si sshpass está instalado
    if ! command -v sshpass &> /dev/null; then
        echo -e "${RED}Error: sshpass no está instalado${NC}"
        echo "Instálalo con: brew install hudochenkov/sshpass/sshpass"
        echo "O configura autenticación por clave SSH: ssh-copy-id $SERVER_USER@$SERVER_IP"
        exit 1
    fi
fi

echo ""
echo -e "${BLUE}Configuración de restauración:${NC}"
echo -e "  Archivo: ${YELLOW}$BACKUP_FILE${NC}"
echo -e "  Servidor: ${YELLOW}$SERVER_IP${NC}"
echo -e "  Usuario: ${YELLOW}$SERVER_USER${NC}"
echo -e "  Directorio: ${YELLOW}$REMOTE_DIR${NC}"
echo ""

# Función para ejecutar comandos remotos
remote_exec() {
    if [ "$USE_SSH_KEY" = true ]; then
        ssh -o StrictHostKeyChecking=no "$SERVER_USER@$SERVER_IP" "$@"
    else
        sshpass -p "$SERVER_PASSWORD" ssh -o StrictHostKeyChecking=no "$SERVER_USER@$SERVER_IP" "$@"
    fi
}

# Función para copiar archivos
remote_copy() {
    if [ "$USE_SSH_KEY" = true ]; then
        scp -o StrictHostKeyChecking=no "$1" "$SERVER_USER@$SERVER_IP:$2"
    else
        sshpass -p "$SERVER_PASSWORD" scp -o StrictHostKeyChecking=no "$1" "$SERVER_USER@$SERVER_IP:$2"
    fi
}

# Confirmar restauración
echo -e "${YELLOW}¿Estás seguro de que quieres restaurar este backup?${NC}"
echo -e "${YELLOW}Esto sobrescribirá los datos existentes. (y/n)${NC}"
read -r response
if [[ ! "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
    echo "Operación cancelada"
    exit 0
fi

echo ""
echo -e "${GREEN}=== Iniciando Restauración ===${NC}\n"

# 1. Verificar conexión
echo -e "${YELLOW}[1/5] Verificando conexión al servidor...${NC}"
if ! remote_exec "echo 'Conexión exitosa'"; then
    echo -e "${RED}Error: No se pudo conectar al servidor${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Conexión establecida${NC}\n"

# 2. Verificar Docker
echo -e "${YELLOW}[2/5] Verificando Docker en el servidor...${NC}"
if ! remote_exec "command -v docker &> /dev/null && docker compose version &> /dev/null"; then
    echo -e "${RED}Error: Docker o Docker Compose no están instalados${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Docker disponible${NC}\n"

# 3. Copiar archivo de backup al servidor
echo -e "${YELLOW}[3/5] Copiando archivo de backup al servidor...${NC}"
BACKUP_FILENAME=$(basename "$BACKUP_FILE")
remote_copy "$BACKUP_FILE" "/tmp/$BACKUP_FILENAME"
echo -e "${GREEN}✓ Archivo copiado${NC}\n"

# 4. Descomprimir si es necesario
echo -e "${YELLOW}[4/5] Preparando archivo de backup...${NC}"
if [[ "$BACKUP_FILENAME" == *.gz ]]; then
    remote_exec "cd /tmp && gunzip -f $BACKUP_FILENAME"
    BACKUP_FILENAME="${BACKUP_FILENAME%.gz}"
fi

if [[ "$BACKUP_FILENAME" == *.tar ]]; then
    # Es un backup completo
    echo -e "${BLUE}Detectado backup completo${NC}"
    remote_exec "cd /tmp && tar -xf $BACKUP_FILENAME"
    SQL_FILE=$(remote_exec "ls /tmp/*.sql 2>/dev/null | head -1")
else
    SQL_FILE="/tmp/$BACKUP_FILENAME"
fi
echo -e "${GREEN}✓ Backup preparado${NC}\n"

# 5. Restaurar base de datos
echo -e "${YELLOW}[5/5] Restaurando base de datos...${NC}"

# Verificar si los contenedores están corriendo
if ! remote_exec "cd $REMOTE_DIR && docker compose ps | grep -q 'Up'"; then
    echo -e "${YELLOW}Los contenedores no están corriendo. Iniciando...${NC}"
    remote_exec "cd $REMOTE_DIR && docker compose up -d"
    echo "Esperando a que la base de datos esté lista..."
    sleep 15
fi

# Restaurar la base de datos
remote_exec "cd $REMOTE_DIR && docker compose exec -T db mariadb -uroot -ppassword openplace < $SQL_FILE"

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Base de datos restaurada exitosamente${NC}\n"
else
    echo -e "${RED}Error: No se pudo restaurar la base de datos${NC}"
    exit 1
fi

# Limpiar archivos temporales
echo -e "${YELLOW}Limpiando archivos temporales...${NC}"
remote_exec "rm -f /tmp/$BACKUP_FILENAME /tmp/*.sql"
echo -e "${GREEN}✓ Limpieza completada${NC}\n"

# Reiniciar servicios
echo -e "${YELLOW}Reiniciando servicios...${NC}"
remote_exec "cd $REMOTE_DIR && docker compose restart app"
echo -e "${GREEN}✓ Servicios reiniciados${NC}\n"

# Resumen final
echo -e "${GREEN}=================================${NC}"
echo -e "${GREEN}  Restauración completada exitosamente${NC}"
echo -e "${GREEN}=================================${NC}"
echo ""
echo -e "Base de datos restaurada desde: ${BLUE}$BACKUP_FILE${NC}"
echo -e "Servidor: ${BLUE}$SERVER_IP${NC}"
echo ""
echo -e "Puedes acceder a la aplicación en:"
echo -e "  ${GREEN}http://$SERVER_IP${NC}"
echo -e "  ${GREEN}https://$SERVER_IP${NC}"
echo ""
