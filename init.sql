-- Database initialization script for Aster Trading Bot
-- This script runs automatically when the PostgreSQL container starts for the first time

-- Create extensions if needed
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Set timezone
SET timezone = 'UTC';

-- Create indexes for better performance (these will be created by the application, but having them here ensures consistency)

-- Note: The actual table creation is handled by the application in src/db.ts
-- This file is mainly for any additional setup, indexes, or initial data

-- Create a function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- The application will create the tables, but we can prepare some utility functions

-- Function to clean up old orders (can be called periodically)
CREATE OR REPLACE FUNCTION cleanup_old_orders(days_old INTEGER DEFAULT 30)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM orders 
    WHERE created_at < NOW() - INTERVAL '1 day' * days_old;
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Function to clean up expired sessions
CREATE OR REPLACE FUNCTION cleanup_expired_sessions()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM sessions 
    WHERE listen_key_expires_at < NOW();
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Create a view for active user statistics (helpful for monitoring)
-- Note: This will be created after tables exist, so it's commented out
-- The application should create this after table initialization

/*
CREATE OR REPLACE VIEW user_stats AS
SELECT 
    u.id as user_id,
    u.tg_id,
    u.created_at as user_created_at,
    CASE WHEN ac.user_id IS NOT NULL THEN true ELSE false END as has_api_credentials,
    ac.last_ok_at as last_successful_api_call,
    s.listen_key_expires_at as stream_expires_at,
    COUNT(o.id) as total_orders,
    COUNT(CASE WHEN o.created_at > NOW() - INTERVAL '24 hours' THEN 1 END) as orders_24h,
    COUNT(CASE WHEN o.created_at > NOW() - INTERVAL '7 days' THEN 1 END) as orders_7d
FROM users u
LEFT JOIN api_credentials ac ON u.id = ac.user_id
LEFT JOIN sessions s ON u.id = s.user_id
LEFT JOIN orders o ON u.id = o.user_id
GROUP BY u.id, u.tg_id, u.created_at, ac.user_id, ac.last_ok_at, s.listen_key_expires_at;
*/

-- Grant necessary permissions
GRANT ALL PRIVILEGES ON DATABASE aster_bot TO aster_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO aster_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO aster_user;

-- Set default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO aster_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO aster_user;