// src/services/api.js
const axios = require('axios');

class GameAPI {
    constructor() {
        // URL de tu API backend
        this.apiUrl = 'api.horizonrp.es'; // Cambia esto a tu dominio real
        // Para desarrollo local usa: http://localhost:3001

        this.axiosInstance = axios.create({
            baseURL: this.apiUrl,
            timeout: 10000,
            headers: {
                'Content-Type': 'application/json'
            }
        });
    }

    // Inicializar (ya no necesita conexión a DB)
    async initDatabase() {
        try {
            console.log('🔌 Conectando con la API del servidor...');
            const response = await this.axiosInstance.get('/api/status');

            if (response.data.status === 'online') {
                console.log('✅ Conexión con la API establecida');
                return true;
            }
            return false;
        } catch (error) {
            console.error('❌ Error conectando con la API:', error.message);
            console.log('ℹ️ El launcher funcionará en modo offline');
            return false;
        }
    }

    // Obtener estadísticas
    async getStatistics() {
        try {
            const response = await this.axiosInstance.get('/api/statistics');
            return response.data;
        } catch (error) {
            console.error('Error obteniendo estadísticas:', error.message);
            return this.getMockStatistics();
        }
    }

    // Obtener noticias
    async getNews() {
        try {
            const response = await this.axiosInstance.get('/api/news');
            return response.data;
        } catch (error) {
            console.error('Error obteniendo noticias:', error.message);
            return this.getMockNews();
        }
    }

    // Verificar usuario
    async checkUser(username) {
        try {
            const response = await this.axiosInstance.get(`/api/user/${encodeURIComponent(username)}`);
            return response.data;
        } catch (error) {
            if (error.response && error.response.status === 404) {
                console.log('Usuario no encontrado');
                return null;
            }
            console.error('Error verificando usuario:', error.message);
            return null;
        }
    }

    // Datos de prueba (fallback para modo offline)
    getMockStatistics() {
        return {
            totalUsers: 1234,
            totalHouses: 150,
            availableHouses: 48,
            totalBusiness: 80,
            activeBusiness: 23,
            totalVehicles: 543,
            activeFactions: 5,
            totalEconomy: 125000000,
            today: {
                newUsersToday: 12,
                uniquePlayersToday: 87,
                totalConnectionsToday: 234
            },
            topPlayers: [
                { username: 'Carlos_Rodriguez', level: 15, played_hours: 234, total_money: 5000000 },
                { username: 'Maria_Gonzalez', level: 12, played_hours: 189, total_money: 3500000 },
                { username: 'Juan_Martinez', level: 10, played_hours: 156, total_money: 2800000 }
            ]
        };
    }

    getMockNews() {
        return [
            {
                id: 1,
                title: '¡Gran Apertura!',
                content: '¡Bienvenido a Horizon Roleplay, disfruta de tu estancia!',
                author: 'Admin',
                date: '16/11/2025',
                image_url: null
            }
        ];
    }

    // Ya no necesita cerrar conexión
    async close() {
        // No hace nada, mantenido por compatibilidad
    }
}

module.exports = GameAPI;