// src/services/api.js
const mysql = require('mysql2/promise');

class GameAPI {
    constructor() {
        // Configuración de la base de datos - Basado en tu dump (usa valores reales)
        this.dbConfig = {
            host: '195.26.252.73',      // IP remota de tu server
            user: 'launcher_user',      // User que creaste
            password: 'HorizonTEST',    // Contraseña
            database: 'samp_db',        // Nombre real de tu DB del dump
            port: 3306,                 // Puerto MySQL
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            connectTimeout: 30000       // Aumentado para evitar ETIMEDOUT
        };

        this.pool = null;
    }

    // Inicializar conexión a la base de datos con logging detallado
    async initDatabase() {
        try {
            console.log('ℹ️ Intentando conectar a DB con config:', this.dbConfig);
            this.pool = await mysql.createPool(this.dbConfig);
            await this.pool.execute('SELECT 1');  // Prueba simple
            console.log('✅ Conexión a la base de datos establecida');
            return true;
        } catch (error) {
            console.error('❌ Error conectando a la base de datos:', error.message, error.code, error.stack);
            console.log('ℹ️ El launcher funcionará en modo sin base de datos');
            return false;
        }
    }

    // Obtener estadísticas de la base de datos - Adaptado a tus tablas reales
    async getStatistics() {
        if (!this.pool) {
            console.warn('⚠️ Usando datos de prueba - conexión a DB fallida');
            return this.getMockStatistics();
        }

        try {
            const stats = {};

            // Total de usuarios registrados (de tabla 'accounts')
            const [users] = await this.pool.execute('SELECT COUNT(*) as total FROM accounts');
            stats.totalUsers = users[0].total || 0;

            // Total de casas y disponibles (de tabla 'house', asumiendo hOwned = 1 para owned)
            const [houses] = await this.pool.execute(
                'SELECT COUNT(*) as total, SUM(CASE WHEN hOwned = 0 THEN 1 ELSE 0 END) as available FROM house'
            );
            stats.totalHouses = houses[0].total || 0;
            stats.availableHouses = houses[0].available || 0;

            // Total de negocios y activos (de tabla 'bizz', asumiendo bOwned = 1 para owned)
            const [business] = await this.pool.execute(
                'SELECT COUNT(*) as total, SUM(CASE WHEN bOwned = 1 THEN 1 ELSE 0 END) as active FROM bizz'
            );
            stats.totalBusiness = business[0].total || 0;
            stats.activeBusiness = business[0].active || 0;

            // Total de vehículos (de tabla 'users_vehicles')
            const [vehicles] = await this.pool.execute('SELECT COUNT(*) as total FROM users_vehicles');
            stats.totalVehicles = vehicles[0].total || 0;

            // Total de facciones activas (de tabla 'family', asumiendo todas son activas; ajusta si hay campo 'active')
            const [factions] = await this.pool.execute('SELECT COUNT(*) as total FROM family');
            stats.activeFactions = factions[0].total || 0;

            // Economía total (suma pCash + pBank de 'accounts')
            const [economy] = await this.pool.execute('SELECT SUM(pCash + pBank) as total FROM accounts');
            stats.totalEconomy = economy[0].total || 0;

            // Estadísticas de hoy (nuevos usuarios, ajustado a 'accounts' con pDataReg o similar; usa DATE(pDataReg) si es datetime)
            stats.today = {
                newUsersToday: 0,
                uniquePlayersToday: 0,
                totalConnectionsToday: 0
            };
            const [todayStats] = await this.pool.execute(`
                SELECT 
                    (SELECT COUNT(*) FROM accounts WHERE DATE(pDataReg) = CURDATE()) as newUsersToday
            `);
            stats.today.newUsersToday = todayStats[0].newUsersToday || 0;

            // Top jugadores (adaptado a 'accounts': usa pLevel, pGameTime, pCash + pBank)
            stats.topPlayers = [];
            const [topPlayers] = await this.pool.execute(`
                SELECT Name as username, pLevel as level, pGameTime as played_hours, (pCash + pBank) as total_money 
                FROM accounts 
                ORDER BY pGameTime DESC 
                LIMIT 10
            `);
            stats.topPlayers = topPlayers;

            return stats;
        } catch (error) {
            console.error('Error obteniendo estadísticas:', error);
            return this.getMockStatistics();
        }
    }

    // Obtener noticias (de tabla 'ucp_news' en tu dump)
    async getNews() {
        if (!this.pool) {
            return this.getMockNews();
        }

        try {
            const [news] = await this.pool.execute(`
                SELECT 
                    n_id as id, 
                    n_title as title, 
                    n_text as content, 
                    'Admin' as author,  // Asumido, ajusta si hay campo real
                    n_images as image_url, 
                    DATE_FORMAT(n_data, '%d/%m/%Y') as date 
                FROM ucp_news 
                ORDER BY n_data DESC 
                LIMIT 10
            `);
            return news;
        } catch (error) {
            console.error('Error obteniendo noticias:', error);
            return this.getMockNews();
        }
    }

    // Verificar usuario (adaptado a 'accounts')
    async checkUser(username) {
        if (!this.pool) {
            return null;
        }

        try {
            const [users] = await this.pool.execute(
                'SELECT Name as username, pLevel as level, pModel as skin, pCash as money, pBank as bank, pGameTime as played_hours FROM accounts WHERE Name = ?',
                [username]
            );
            return users[0] || null;
        } catch (error) {
            console.error('Error verificando usuario:', error);
            return null;
        }
    }

    // Datos de prueba (fallback)
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
            today: { newUsersToday: 12, uniquePlayersToday: 87, totalConnectionsToday: 234 },
            topPlayers: [
                { username: 'Carlos_Rodriguez', level: 15, played_hours: 234, total_money: 5000000 },
                { username: 'Maria_Gonzalez', level: 12, played_hours: 189, total_money: 3500000 },
                { username: 'Juan_Martinez', level: 10, played_hours: 156, total_money: 2800000 }
            ]
        };
    }

    getMockNews() {
        return [
            { id: 1, title: '¡Gran Actualización 2.0!', content: 'Nueva isla...', author: 'Admin', date: '15/11/2024', image_url: null },
            { id: 2, title: 'Sistema de Empresas', content: 'Ahora puedes...', author: 'Admin', date: '10/11/2024', image_url: null },
            { id: 3, title: 'Evento Halloween', content: 'Premios especiales...', author: 'Admin', date: '05/11/2024', image_url: null }
        ];
    }

    async close() {
        if (this.pool) {
            await this.pool.end();
        }
    }
}

module.exports = GameAPI;