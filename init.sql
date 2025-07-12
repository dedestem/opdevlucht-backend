ALTER USER 'opdevlucht'@'%' IDENTIFIED WITH mysql_native_password BY 'db_password';
GRANT ALL PRIVILEGES ON opdevlucht_db.* TO 'opdevlucht'@'%';
FLUSH PRIVILEGES;
