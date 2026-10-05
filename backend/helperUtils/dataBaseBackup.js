// MongoDB dump and S3 backup function
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
// const { uploadFilesToAzure } = require('../controllers/uploadAzureController');
// Constants
const BACKUP_DIR = path.join(__dirname, '..', 'database_backups/backups.gz'); // Store backups in main directory with meaningful name
const MAX_BACKUPS = 10; // Keep only the last 10 backups
// MongoDB dump and upload to Azure
const backupMongoDB = async () => {
    console.log("Starting MongoDB backup...");
    if (!fs.existsSync(BACKUP_DIR)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
    const backupPath = path.join(BACKUP_DIR, `backup-${new Date().toISOString()}.gz`);
    const dumpCommand = `mongodump --uri="${process.env.BASE_URL}" --gzip --archive=${backupPath}`;

    exec(dumpCommand, (err, stdout, stderr) => {
        if (err) {
            console.error(`Error during MongoDB backup: ${err}`);
            return;
        }
        console.log("MongoDB backup completed:", stdout);

        // Upload to S3 after backup
        uploadBackupToS3(backupPath);
    });
};

// Upload backup to S3
const uploadBackupToS3 = async (backupPath) => {
    const file = fs.readFileSync(backupPath);
    const fileObj = {
        buffer: file,
        filename: path.basename(backupPath),
    };

    try {
        // Call function to clean up old backups after the new one is created
        await cleanUpOldBackups();
        // const uploadedFiles = await uploadFilesToAzure([fileObj]);

        uploadedFiles.forEach((uploadedFile) => {
            // console.log(`Backup uploaded to S3: ${uploadedFile.fileUrl}`);
            console.log(`Database Backup uploaded to Azure: ${uploadedFile.fileUrl}`);
        });
    } catch (err) {
        console.error("Error uploading backup to Azure:", err);
    }
};


// Cleanup old backups, keep only the last MAX_BACKUPS backups
const cleanUpOldBackups = async () => {
    try {
        const files = await fs.promises.readdir(BACKUP_DIR);

        // Filter for .gz files only
        const backupFiles = files.filter(file => file.endsWith('.gz'));

        // Sort files by creation time ascending (oldest first)
        const sortedFiles = backupFiles.sort((a, b) => {
            const aTime = fs.statSync(path.join(BACKUP_DIR, a)).birthtimeMs; // use creation time
            const bTime = fs.statSync(path.join(BACKUP_DIR, b)).birthtimeMs;
            return aTime - bTime;
        });

        // Keep only the last MAX_BACKUPS, delete the rest
        if (sortedFiles.length > MAX_BACKUPS) {
            const filesToDelete = sortedFiles.slice(0, sortedFiles.length - MAX_BACKUPS);
            for (const oldBackup of filesToDelete) {
                const oldBackupPath = path.join(BACKUP_DIR, oldBackup);
                await fs.promises.unlink(oldBackupPath);
                console.log(`Deleted old backup: ${oldBackup}`);
            }
        }
    } catch (err) {
        console.error("Error cleaning up old backups:", err);
    }
};


module.exports = { backupMongoDB };