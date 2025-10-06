#!/bin/bash

# Script de despliegue para OpenPlace usando clave SSH
# (Alternativa más segura que usar contraseña)

set -e

# Configuración del servidor
SERVER_IP="192.168.1.16"
SERVER_USER="root"
REMOTE_DIR="/opt/openplace"
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"

# Colores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}=== OpenPlace - Script de Despliegue (SSH Key) ===${NC}\n"

# Función para ejecutar comandos remotos via SSH
remote_exec() {
    ssh -o StrictHostKeyChecking=no "$SERVER_USER@$SERVER_IP" "$@"
}

# 1. Verificar conexión al servidor
echo -e "${YELLOW}[1/7] Verificando conexión al servidor...${NC}"
if ! remote_exec "echo 'Conexión exitosa'"; then
    echo -e "${RED}Error: No se pudo conectar al servidor${NC}"
    echo "Asegúrate de haber copiado tu clave SSH pública al servidor:"
    echo "  ssh-copy-id root@$SERVER_IP"
    exit 1
fi
echo -e "${GREEN}✓ Conexión establecida con $SERVER_IP${NC}\n"

# 2. Verificar Docker en el servidor
echo -e "${YELLOW}[2/7] Verificando Docker en el servidor...${NC}"
if ! remote_exec "command -v docker &> /dev/null && docker compose version &> /dev/null"; then
    echo -e "${RED}Error: Docker o Docker Compose no están instalados en el servidor${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Docker y Docker Compose instalados${NC}\n"

# 3. Preparar directorio en el servidor
echo -e "${YELLOW}[3/7] Preparando directorio de instalación...${NC}"
remote_exec "mkdir -p $REMOTE_DIR"
echo -e "${GREEN}✓ Directorio creado en $REMOTE_DIR${NC}\n"

# 4. Copiar archivos del proyecto al servidor
echo -e "${YELLOW}[4/7] Copiando archivos del proyecto al servidor...${NC}"
echo "Desde: $LOCAL_DIR"
echo "Hacia: $SERVER_USER@$SERVER_IP:$REMOTE_DIR"
echo ""

# Verificar que existe .env local
if [ ! -f "$LOCAL_DIR/.env" ]; then
    echo -e "${RED}Error: No se encontró el archivo .env local${NC}"
    echo "Por favor, crea el archivo .env antes de desplegar"
    exit 1
fi

# Verificar que el submódulo frontend está inicializado
if [ ! -f "$LOCAL_DIR/frontend/404.html" ]; then
    echo -e "${YELLOW}El submódulo frontend no está inicializado. Inicializando...${NC}"
    cd "$LOCAL_DIR"
    git submodule update --init --recursive
    cd - > /dev/null
fi

# Crear un tar temporal incluyendo .env y frontend
echo "Comprimiendo archivos (incluyendo .env y frontend)..."
tar -czf /tmp/openplace-deploy.tar.gz \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='dist' \
    --exclude='*.log' \
    --exclude='._*' \
    --exclude='.DS_Store' \
    -C "$LOCAL_DIR" .

echo "Transfiriendo al servidor..."
scp -o StrictHostKeyChecking=no /tmp/openplace-deploy.tar.gz "$SERVER_USER@$SERVER_IP:/tmp/"

echo "Extrayendo archivos en el servidor..."
remote_exec "
    cd $REMOTE_DIR
    tar -xzf /tmp/openplace-deploy.tar.gz
    rm /tmp/openplace-deploy.tar.gz
"

rm /tmp/openplace-deploy.tar.gz
echo -e "${GREEN}✓ Archivos copiados al servidor${NC}\n"

# 5. Configurar archivo .env para Docker
echo -e "${YELLOW}[5/7] Configurando archivo .env para Docker...${NC}"

# Actualizar DATABASE_URL en el .env del servidor para usar el hostname de Docker
remote_exec "
    cd $REMOTE_DIR
    if [ -f .env ]; then
        # Cambiar localhost por 'db' (hostname del contenedor de Docker)
        sed -i 's|DATABASE_URL=\"mysql://root:password@localhost/openplace\"|DATABASE_URL=\"mysql://root:password@db/openplace\"|g' .env
        echo 'Archivo .env configurado para Docker'
    else
        echo 'ADVERTENCIA: No se encontró .env en el servidor'
    fi
"
echo -e "${GREEN}✓ Archivo .env configurado${NC}\n"

# 6. Verificar si hay contenedores corriendo
echo -e "${YELLOW}[6/7] Verificando servicios existentes...${NC}"
IS_RUNNING=$(remote_exec "
    cd $REMOTE_DIR
    if docker compose ps -q | grep -q .; then
        echo 'yes'
    else
        echo 'no'
    fi
")

if [ "$IS_RUNNING" = "yes" ]; then
    echo -e "${YELLOW}Servicios en ejecución detectados. Realizando actualización sin pérdida de datos...${NC}"

    # Solo reiniciar el contenedor de la aplicación, NO la base de datos
    remote_exec "
        cd $REMOTE_DIR
        echo 'Deteniendo solo el contenedor de la aplicación...'
        docker compose stop app

        echo 'Reconstruyendo la imagen de la aplicación...'
        docker compose build app

        echo 'Iniciando la aplicación actualizada...'
        docker compose up -d app

        echo 'La base de datos NO ha sido tocada, todos los datos están preservados.'
    "
else
    echo -e "${YELLOW}No hay servicios corriendo. Realizando despliegue inicial...${NC}"
    remote_exec "
        cd $REMOTE_DIR
        docker compose up -d
    "
fi
echo -e "${GREEN}✓ Actualización completada${NC}\n"

# 7. Verificar estado de los servicios
echo -e "${YELLOW}[7/7] Verificando estado de los servicios...${NC}"
remote_exec "
    cd $REMOTE_DIR

    echo 'Esperando a que los servicios estén listos...'
    sleep 10

    echo ''
    echo '=== Estado de los contenedores ==='
    docker compose ps

    echo ''
    echo '=== Últimas líneas del log de la aplicación ==='
    docker compose logs --tail=20 app
"
echo -e "${GREEN}✓ Servicios verificados${NC}\n"

# Resumen final
echo -e "${GREEN}=================================${NC}"
echo -e "${GREEN}  Despliegue completado exitosamente${NC}"
echo -e "${GREEN}=================================${NC}"
echo ""
echo -e "Accede a OpenPlace en:"
echo -e "  ${GREEN}http://$SERVER_IP${NC}"
echo -e "  ${GREEN}https://$SERVER_IP${NC}"
echo ""
echo -e "Para ver los logs:"
echo -e "  ${YELLOW}ssh root@$SERVER_IP 'cd $REMOTE_DIR && docker compose logs -f'${NC}"
echo ""
echo -e "Para reiniciar los servicios:"
echo -e "  ${YELLOW}ssh root@$SERVER_IP 'cd $REMOTE_DIR && docker compose restart'${NC}"
echo ""
echo -e "Para detener los servicios:"
echo -e "  ${YELLOW}ssh root@$SERVER_IP 'cd $REMOTE_DIR && docker compose down'${NC}"
echo ""
