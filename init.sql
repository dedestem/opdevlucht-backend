CREATE USER IF NOT EXISTS 'opdevlucht'@'%' IDENTIFIED BY 'db_password';
GRANT ALL PRIVILEGES ON opdevlucht_db.* TO 'opdevlucht'@'%';
FLUSH PRIVILEGES;
