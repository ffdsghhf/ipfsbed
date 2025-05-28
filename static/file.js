// Move getShortUrl function to global scope (before $(document).ready)
async function getShortUrl(longUrl) {
    if (!$('#enableShortUrl').prop('checked')) {
        return longUrl; // 如果未启用短网址，则返回原始URL
    }

    try {
        // 这里的 '/api/shorten-url' 是您Cloudflare Worker的访问路径
        // 您可能需要根据实际部署情况调整
        const response = await fetch('/api/shorten-url', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ longUrl: longUrl }),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: 'Failed to parse error response from shortener service' }));
            console.warn('Shortener service error:', response.status, errorData.error);
            showToast(_t('shorten-url-failed-fallback', { default: '短链接获取失败，已使用原始链接。' }), 'warning');
            return longUrl; // 失败时回退到长链接
        }

        const data = await response.json();
        if (data.shortUrl) {
            console.log('Short URL generated:', data.shortUrl);
            return data.shortUrl;
        } else {
            console.warn('Shortener service did not return shortUrl:', data.error || 'Unknown error from shortener');
            showToast(_t('shorten-url-failed-fallback', { default: '短链接获取失败，已使用原始链接。' }), 'warning');
            return longUrl; // 失败时回退到长链接
        }
    } catch (error) {
        console.warn('Error calling shortener service:', error);
        showToast(_t('shorten-url-failed-fallback', { default: '短链接获取失败，已使用原始链接。' }), 'warning');
        return longUrl; // 失败时回退到长链接
    }
}

// Move updateProgress function to global scope
function updateProgress(e, randomClass) {
    const percent = Math.floor((e.loaded / e.total) * 100);
    $(`.${randomClass}`).find('.progress-inner').css('width', `${percent}%`);
    $(`.${randomClass}`).find('.progress-status').text(`${percent}%`);
}

// Add upload queue management
const uploadQueue = {
    queue: [],
    maxConcurrent: 5, // 最大同时上传文件数
    current: 0,
    
    add(uploadTask) {
        this.queue.push(uploadTask);
        this.process();
    },
    
    process() {
        if (this.current >= this.maxConcurrent || this.queue.length === 0) {
            return;
        }
        
        const task = this.queue.shift();
        this.current++;
        
        task().finally(() => {
            this.current--;
            this.process(); // 处理下一个任务
        });
    }
};

// 添加用于处理大文件夹的常量和配置
const folderUploadConfig = {
    maxFolderSize: 10 * 1024 * 1024, // 10MB
    maxFileCount: 8, // 超过8个文件就打包
    compressLargeFolder: true // 是否启用大文件夹自动压缩
};

// 添加ZIP压缩功能
async function compressFolderToZip(files, folderName) {
    try {
        const zip = new JSZip();
        
        // 添加所有文件到zip
        for (const file of files) {
            const relativePath = file.webkitRelativePath || file.name;
            const fileContent = await readFileAsArrayBuffer(file);
            zip.file(relativePath, fileContent);
        }
        
        // 生成zip文件
        const zipBlob = await zip.generateAsync({
            type: 'blob',
            compression: 'DEFLATE',
            compressionOptions: {
                level: 3 // 压缩级别 1-9，9为最高压缩率但最慢
            }
        }, function(metadata) {
            // Optional: Log progress or update a UI element if needed
            console.log(`Compression progress: ${metadata.percent.toFixed(2)}%`);
            // ...existing code to update UI (if desired)...
        });
        
        // Show a completion toast with consistent duration (5000ms)
        showToast(_t('compression-complete', {default: '压缩完成，准备上传...'}), 'success', 5000);
        
        // 确保使用正确的文件夹名称，移除可能的尾随斜杠
        const cleanFolderName = folderName.endsWith('/') ? folderName.slice(0, -1) : folderName;
        
        // 创建File对象
        const zipFile = new File([zipBlob], `${cleanFolderName}.zip`, { 
            type: 'application/zip',
            lastModified: new Date().getTime()
        });
        
        return zipFile;
    } catch (error) {
        console.error('文件夹压缩失败:', error);
        showToast(_t('compress-failed', {default: '文件夹压缩失败'}), 'error', 5000);
        throw error;
    }
}

// 辅助函数：将文件读取为ArrayBuffer
function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
    });
}

$(document).ready(() => {
    // Directly start initialization of event listeners
    initEventListeners();
    // Check if accessing a shared link
    checkAccessMode();

    // Create toast container
    $('body').append('<div class="toast-container"></div>');

    // Initialize buttons in disabled state
    $('.copyall, #shareSelected').addClass('disabled');

    function initEventListeners() {
        $(document).on('paste', handlePasteUpload);
        
        // Upload mode toggle handler
        $('#uploadModeToggle').on('change', function() {
            const isDirectoryMode = $(this).prop('checked');
            localStorage.setItem('ipfsbed_directory_mode', isDirectoryMode ? 'true' : 'false');
            
            // Configure file inputs based on mode
            if (isDirectoryMode) {
                $('#directory').attr('webkitdirectory', '').attr('directory', '');
                $('#file').removeAttr('webkitdirectory').removeAttr('directory');
            } else {
                $('#directory').removeAttr('webkitdirectory').removeAttr('directory');
                $('#file').removeAttr('webkitdirectory').removeAttr('directory');
            }
            
            // Both inputs should remain hidden until triggered by click
            $('#file, #directory').hide();
        });
        
        // Try to restore toggle state from localStorage
        const savedDirectoryMode = localStorage.getItem('ipfsbed_directory_mode');
        if (savedDirectoryMode === 'true') {
            $('#uploadModeToggle').prop('checked', true);
        }
        
        // Update click handler to use correct input based on mode
        $('.upload .content').on('click', () => {
            const isDirectoryMode = $('#uploadModeToggle').prop('checked');
            if (isDirectoryMode) {
                $('#directory').click();
            } else {
                $('#file').click();
            }
        });
        
        // Handle file input change
        $('#file').on('change', () => {
            const files = $('#file')[0].files;
            upload(files);
        });
        
        // Handle directory input change
        $('#directory').on('change', () => {
            const files = $('#directory')[0].files;
            uploadDirectory(files);
        });
        
        $('#dragbox').on('dragover', e => e.preventDefault())
                     .on('dragenter', handleDragEnter)
                     .on('dragleave', handleDragLeave)
                     .on('drop', function(e) {
            e.preventDefault();
            $('.upload').removeClass('dragenter');
            $('.upload .content .icon').css('transform', '');
            $('.upload .content .desc').css('transform', '');
            const items = e.originalEvent.dataTransfer.items;
            if (items && items.length && hasDirectory(items)) {
                getFilesFromDataTransferItems(items).then(files => {
                    uploadDirectory(files);
                });
            } else {
                upload(e.originalEvent.dataTransfer.files);
            }
        });
        // For shared link access
        $('#submitAccessPassphrase').on('click', () => {
            const encryptedPayload = $('#shareAccessPrompt').data('payload');
            const passphrase = $('#accessPassphraseInput').val();
            handlePassphraseSubmit(encryptedPayload, passphrase);
        });
        // Clear passphrase error on input
        $('#accessPassphraseInput').on('input', () => {
            $('#passphraseError').text('');
        });
        // Allow pressing Enter to submit passphrase
        $('#accessPassphraseInput').on('keypress', (e) => {
            if (e.which === 13) { // Enter key
                $('#submitAccessPassphrase').click();
            }
        });
        
        // Batch sharing button functionality
        $('#shareSelected').on('click', function() {
            if ($(this).hasClass('disabled')) return;
            promptBatchSharePassphrase();
        });
        
        // New: Toggle all checkbox functionality
        $('#toggleAllFiles').on('click', function() {
            if ($(this).prop('disabled')) return;
            const isChecked = $(this).prop('checked');
            $('.file-select-checkbox').prop('checked', isChecked);
            updateShareSelectedButtonState();
        });
        
        // New: Listen for changes on individual file checkboxes
        $(document).on('change', '.file-select-checkbox', function() {
            updateShareSelectedButtonState();
            
            // If any checkbox is unchecked, uncheck the "toggle all" checkbox
            if (!$(this).prop('checked')) {
                $('#toggleAllFiles').prop('checked', false);
            } else if ($('.file-select-checkbox:checked').length === $('.file-select-checkbox').length) {
                // If all checkboxes are checked, check the "toggle all" checkbox
                $('#toggleAllFiles').prop('checked', true);
            }
        });

        // Add click handler for copy all that respects disabled state
        $('.copyall').on('click', function(e) {
            if ($(this).hasClass('disabled')) {
                e.preventDefault();
                return false;
            }
            copyAllLinks();
            return false;
        });
    }
    
    // Enhanced drag and drop visual feedback
    function handleDragEnter(e) {
        e.preventDefault();
        $('.upload').addClass('dragenter');
        $('.upload .content .icon').css('transform', 'translateY(-15px) scale(1.1)');
        $('.upload .content .desc').css('transform', 'scale(1.05)');
    }
    
    function handleDragLeave(e) {
        e.preventDefault();
        $('.upload').removeClass('dragenter');
        $('.upload .content .icon').css('transform', '');
        $('.upload .content .desc').css('transform', '');
    }

    function handlePasteUpload(event) {
        const items = (event.clipboardData || event.originalEvent.clipboardData).items;
        const files = [];
        
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            
            // 支持所有文件类型，不仅仅是图片
            if (item.kind === 'file') {
                const file = item.getAsFile();
                if (file) {
                    files.push(file);
                }
            }
        }
        
        if (files.length > 0) {
            upload(files);
            return;
        }
        
        showToast(_t('clipboard-empty'), 'error');
    }

    function handleDropUpload(e) {
        e.preventDefault();
        $('.upload').removeClass('dragenter');
        $('.upload .content .icon').css('transform', '');
        $('.upload .content .desc').css('transform', '');
        upload(e.originalEvent.dataTransfer.files);
    }

    function upload(files) {
        const maxSize = 5242880 * 20; // 100MB
        const allowedExtensions = [
            // 图片格式
            '.JPG', '.JPEG', '.PNG', '.GIF', '.BMP', '.WEBP', '.ICO', '.SVG', '.TIFF', '.TIF', '.HEIC', '.AVIF',
            
            // 办公文档
            '.DOC', '.DOCX', '.XLS', '.XLSX', '.PPT', '.PPTX', '.PDF', '.ODF', '.ODS', '.ODT', 
            '.WPS', '.WPT', '.DOT', '.DOTX', '.XLT', '.XLTX', '.POT', '.POTX',
            
            // 文本文件
            '.TXT', '.MD', '.MARKDOWN', '.RTF', '.CSV', '.JSON', '.XML', '.YAML', '.YML',
            '.INI', '.CFG', '.CONF', '.LOG', '.NFO',
            '.LICENSE', '.README',
            
            // 视频文件
            '.MP4', '.WEBM', '.OGV', '.MKV', '.AVI', '.MOV', '.WMV', '.FLV', '.F4V', 
            '.M4V', '.MPG', '.MPEG', '.3GP', '.3G2', '.TS', '.MTS', '.M2TS',
            
            // 音频文件
            '.MP3', '.WAV', '.OGG', '.M4A', '.AAC', '.WMA', '.FLAC', '.APE', 
            '.OPUS', '.AIFF', '.DSD', '.DSF', '.CUE', '.MID', '.MIDI',
            
            // 字幕文件
            '.SRT', '.ASS', '.SSA', '.VTT', '.SUB', '.IDX',
            
            // 电子书格式
            '.EPUB', '.MOBI', '.AZW3', '.FB2', '.LIT', '.LRF', '.PDB', '.PRC',
            
            // 压缩文件
            '.ZIP', '.RAR', '.7Z', '.TAR', '.GZ', '.BZ2', '.XZ', '.TGZ', '.TBZ', '.TXZ',
            
            // 编程和开发文件
            '.HTML', '.HTM', '.CSS', '.JS', '.TS', '.PHP', '.ASP', '.ASPX', '.JSP', '.PY', '.RB', '.GO', '.JAVA', '.C', '.CPP', '.CS', '.H', '.M', '.SWIFT', '.VB', '.PL', '.LUA', '.R', '.DART', '.SQL', '.SH', '.BAT', '.PS1', '.CMD',
            
            // 3D模型和设计文件
            '.OBJ', '.STL', '.3DS', '.FBX', '.BLEND', '.SKP', '.STEP', '.STP', '.IGES', '.IGS',
            
            // 字体文件
            '.TTF', '.OTF', '.WOFF', '.WOFF2', '.EOT',
            
            // 图表和图形文件
            '.AI', '.EPS', '.PS', '.PSD', '.XCF', '.CDR', '.FIG',
            
            // 科学和研究数据
            '.MAT', '.HDF5', '.HDF', '.H5', '.FIT', '.FITS',
            
            // 演示和发布文件
            '.KEY', '.ODP', '.PPS', '.PPSX',
            
            // 地理数据
            '.KML', '.KMZ', '.SHP', '.DBF', '.SHX', '.GPX', '.OSM',
            
            // 数据库文件
            '.DB', '.SQLITE', '.SQLITE3', '.MDB', '.ACCDB',
            
            // 游戏和模拟器文件
            '.ROM', '.SAV', '.NES', '.GBA', '.N64', '.ISO', '.CUE', '.BIN',
            
            // CAD和工程文件
            '.DWG', '.DXF', '.DGN',
            
            // 其他常用文件
            '.TORRENT', '.ICS', '.VCF'
        ];

        Array.from(files).forEach(file => {
            const fileExtension = file.name.substring(file.name.lastIndexOf('.')).toUpperCase();

            if (!allowedExtensions.includes(fileExtension)) {
                showToast(_t('unsupported-type'), 'error');
                $('#file').val(null);
                return;
            }

            if (file.size >= maxSize) {
                showToast(_t('file-too-large', {size: maxSize / 1024 / 1024}), 'error');
                return;
            }

            // 将上传任务添加到队列
            uploadQueue.add(() => uploadToImg2IPFS(file));
        });
    }

    function uploadToImg2IPFS(file) {
        return new Promise((resolve, reject) => {
            document.querySelector('.container').classList.add('start');
            const apis = [
                'https://api.img2ipfs.org/api/v0/add?pin=false',
                'http://[2a0b:4e07:8:1::8d1]:5001/api/v0/add?pin=false'
                // 'https://api.img2ipfs.org/api/v0/add?pin=false'
            ];
            const formData = new FormData();
            formData.append('file', file);
            const randomClass = Date.now().toString(36);
            
            $('.filelist .list').append(createFileItem(file, randomClass));
            $(`.${randomClass}`).addClass('uploading');
            
            const tryUpload = (apiIndex = 0, retryCount = 0) => {
                if (apiIndex >= apis.length) {
                    handleError(randomClass, _t('all-apis-failed'));
                    reject(new Error('All APIs failed'));
                    return;
                }
                
                $.ajax({
                    url: apis[apiIndex],
                    type: 'post',
                    dataType: 'json',
                    processData: false,
                    contentType: false,
                    data: formData,
                    timeout: 120000,
                    xhr: () => {
                        const xhr = $.ajaxSettings.xhr();
                        if (xhr.upload) {
                            xhr.upload.addEventListener('progress', e => updateProgress(e, randomClass), false);
                        }
                        return xhr;
                    },
                    success: async res => {
                        if (res.Hash) {
                            await handleUploadSuccess(res, randomClass, file);
                            setTimeout(() => seeding(res), 1000);
                            resolve(res);
                        } else {
                            if (retryCount < 2) {
                                setTimeout(() => tryUpload(apiIndex, retryCount + 1), 1000);
                            } else {
                                tryUpload(apiIndex + 1, 0);
                            }
                        }
                    },
                    error: (xhr, status) => {
                        if (status === 'timeout') {
                            tryUpload(apiIndex + 1, 0);
                        } else if (retryCount < 2) {
                            setTimeout(() => tryUpload(apiIndex, retryCount + 1), 1000);
                        } else {
                            tryUpload(apiIndex + 1, 0);
                        }
                    }
                });
            };

            tryUpload();
        });
    }

    // 修改uploadDirectory函数，添加自动压缩功能
    function uploadDirectory(fileList) {
        if (!fileList || !fileList.length) return;
        // 计算总大小和文件数量
        let totalSize = 0;
        Array.from(fileList).forEach(f => totalSize += f.size);
        const fileCount = fileList.length;

        // 限制：最大 100MB，总文件数不超过 500
        const maxFolderSize = 5242880 * 20;  // 100MB
        const maxFolderFiles = 500;
        if (totalSize > maxFolderSize) {
            showToast(`文件夹大小不可超过 ${maxFolderSize/1024/1024} MB`, 'error');
            return;
        }
        if (fileCount > maxFolderFiles) {
            showToast(`文件夹内文件数量不可超过 ${maxFolderFiles} 个`, 'error');
            return;
        }

        // 修复文件夹名称提取逻辑
        let folderName = '';
        if (fileList[0].webkitRelativePath) {
            // 从相对路径中提取顶级文件夹名称
            const pathParts = fileList[0].webkitRelativePath.split('/');
            folderName = pathParts[0]; // 取第一个部分作为文件夹名称
        } else {
            // 如果没有相对路径，使用默认名称
            folderName = 'uploaded_folder';
        }
        
        // 判断是否需要压缩
        const needsCompression = folderUploadConfig.compressLargeFolder && 
            (totalSize > folderUploadConfig.maxFolderSize || fileCount > folderUploadConfig.maxFileCount);
        
        if (needsCompression) {
            // 添加压缩任务到队列
            uploadQueue.add(async () => {
                try {
                    const zipFile = await compressFolderToZip(fileList, folderName);
                    // 上传压缩后的ZIP文件
                    return uploadToImg2IPFS(zipFile);
                } catch (error) {
                    console.error('压缩上传失败:', error);
                    showToast(_t('compress-upload-failed', {default: '压缩上传失败'}), 'error');
                    throw error;
                }
            });
        } else {
            // 将文件夹上传任务添加到队列（原始方式）
            uploadQueue.add(() => uploadDirectoryToIPFS(fileList, folderName, totalSize));
        }
    }

    function uploadDirectoryToIPFS(fileList, folderName, totalSize) {
        return new Promise((resolve, reject) => {
            const formData = new FormData();
            Array.from(fileList).forEach(f => {
                formData.append('file', f, f.webkitRelativePath || f.name);
            });

            const randomClass = Date.now().toString(36) + '_dir';
            $('.filelist .list').append(createDirectoryItem(folderName, totalSize, randomClass));
            $(`.${randomClass}`).addClass('uploading');

            const apis = [
                'https://gw.ipfsbed.is-an.org/api/v0/add?pin=false&recursive=true&wrap-with-directory=true',
                'https://gw2.ipfsbed.is-an.org/api/v0/add?pin=false&recursive=true&wrap-with-directory=true'
                // 'https://api.img2ipfs.org/api/v0/add?pin=false&recursive=true&wrap-with-directory=true'
            ];
            
            // 增加请求超时时间，避免大文件夹上传导致超时
            const uploadTimeout = Math.max(300000, totalSize / 1024 * 30); // 基于大小动态调整超时时间
            
            const tryUpload = (apiIndex = 0, retryCount = 0) => {
                if (apiIndex >= apis.length) {
                    handleError(randomClass, _t('all-apis-failed'));
                    reject(new Error('All APIs failed'));
                    return;
                }
                
                $.ajax({
                    url: apis[apiIndex],
                    type: 'post',
                    dataType: 'text',
                    processData: false,
                    contentType: false,
                    data: formData,
                    timeout: uploadTimeout, // 使用动态超时时间
                    xhr: () => {
                        const xhr = $.ajaxSettings.xhr();
                        if (xhr.upload) {
                            xhr.upload.addEventListener('progress', e => updateProgress(e, randomClass), false);
                        }
                        return xhr;
                    },
                    success: async res => {
                        const lines = res.trim().split('\n');
                        let dirObj = null;
                        for (let i = lines.length - 1; i >= 0; i--) {
                            try {
                                const obj = JSON.parse(lines[i]);
                                if (obj.Name === folderName) {
                                    dirObj = obj;
                                    break;
                                }
                            } catch {}
                        }
                        if (dirObj && dirObj.Hash) {
                            await handleDirectoryUploadSuccess(dirObj, folderName, totalSize, randomClass);
                            setTimeout(() => seeding(dirObj), 1000);
                            resolve(dirObj);
                        } else {
                            if (retryCount < 2) {
                                setTimeout(() => tryUpload(apiIndex, retryCount + 1), 1000);
                            } else {
                                tryUpload(apiIndex + 1, 0);
                            }
                        }
                    },
                    error: (xhr, status) => {
                        if (status === 'timeout') {
                            tryUpload(apiIndex + 1, 0);
                        } else if (retryCount < 2) {
                            setTimeout(() => tryUpload(apiIndex, retryCount + 1), 1000);
                        } else {
                            tryUpload(apiIndex + 1, 0);
                        }
                    }
                });
            };
            
            tryUpload();
        });
    }

    function createFileItem(file, randomClass) {
        // Get file icon based on file type
        const fileIcon = getFileTypeIcon(file.name);
        const passphrase = $('#passphraseInput').val();
        
        // Determine which copy icon/text to show initially based on passphrase
        let copyButtonTitle = passphrase ? _t('copy-share-link') : _t('copy-link');
        let copyFunction = passphrase ? `copyShareLink(this)` : `copyLinkUrl(this)`;

        return `
            <div class="item ${randomClass}">
                <div class="file">
                    <input type="checkbox" class="file-select-checkbox" title="${_t('select-for-batch-sharing')}">
                    ${fileIcon}
                    <div class="desc">
                        <div class="desc__name">${file.name}</div>
                        <div class="desc__size">${_t('file-size', {size: formatBytes(file.size)})}</div>
                    </div>
                    <a href="javascript:void(0);" class="link copy-primary-link" title="${copyButtonTitle}" onclick="${copyFunction}; return false;">
                        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" class="icon-copy">
                            <path d="M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z" fill="#909399"/>
                        </svg>
                    </a>
                    <a href="javascript:void(0);" class="link" title="CID" onclick="copyCID(this); return false;">
                        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" class="icon-copy-cid">
                            <path d="M14,8H10V6H14V8M20,4V20C20,21.1 19.1,22 18,22H6C4.9,22 4,21.1 4,20V4C4,2.9 4.9,2 6,2H18C19.1,2 20,2.9 20,4M18,13H6V20H18V13M18,4H6V11H18V4H14,15H10V17H14V15Z" fill="#909399"/>
                        </svg>
                    </a>
                    <a title="delete" class="link" onclick="deleteItem(this); return false;">
                        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" class="icon-delete">
                            <path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z" fill="#909399"/>
                        </svg>
                    </a>
                </div>
                <div class="progress">
                    <div class="progress-bar">
                        <div class="progress-inner"></div>
                    </div>
                    <div class="progress-status">0%</div>
                </div>
                <!-- URL display text input -->
                <div class="url-display" style="display: none; margin-top: 8px;">
                    <input type="text" class="file-url-input" style="width: 100%; padding: 6px; border: 1px solid #dcdfe6; border-radius: 4px; box-sizing: border-box;" readonly>
                </div>
                <!-- Hidden inputs to store the data -->
                <input type="hidden" class="data-url" value="">
                <input type="hidden" class="data-cid" value="">
                <input type="hidden" class="data-filename" value="${file.name}">
                <input type="hidden" class="data-passphrase-protected" value="${passphrase ? 'true' : 'false'}">
            </div>
        `;
    }
    
    // Function to get appropriate icon based on file type
    function getFileTypeIcon(filename) {
        const extension = filename.split('.').pop().toLowerCase();
        const imageTypes = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'];
        const docTypes = ['doc', 'docx', 'pdf', 'xls', 'xlsx', 'ppt', 'pptx', 'odf', 'ods', 'odt'];
        const videoTypes = ['mp4', 'webm', 'ogv', 'mkv', 'avi', 'mov', 'wmv', 'flv'];
        const audioTypes = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'wma', 'flac'];
        const archiveTypes = ['zip', 'rar', '7z', 'tar', 'gz'];
        
        let iconPath;
        
        if (imageTypes.includes(extension)) {
            iconPath = '<svg class="icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M8.5,13.5L11,16.5L14.5,12L19,18H5M21,19V5C21,3.89 20.1,3 19,3H5A2,2 0 0,0 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19Z" fill="#909399"/></svg>';
        } else if (docTypes.includes(extension)) {
            iconPath = '<svg class="icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M6,2A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2H6M6,4H13V9H18V20H6V4M8,12V14H16V12H8M8,16V18H13V16H8Z" fill="#909399"/></svg>';
        } else if (videoTypes.includes(extension)) {
            iconPath = '<svg class="icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M18,4L20,8H17L15,4H13L15,8H12L10,4H8L10,8H7L5,4H4A2,2 0 0,0 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V4H18M13,16V10H21V16H13Z" fill="#909399"/></svg>';
        } else if (audioTypes.includes(extension)) {
            iconPath = '<svg class="icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M14,3.23V5.29C16.89,6.15 19,8.83 19,12C19,15.17 16.89,17.84 14,18.7V20.77C18,19.86 21,16.28 21,12C21,7.72 18,4.14 14,3.23M16.5,12C16.5,10.23 15.5,8.71 14,7.97V16C15.5,15.29 16.5,13.76 16.5,12M3,9V15H7L12,20V4L7,9H3Z" fill="#909399"/></svg>';
        } else if (archiveTypes.includes(extension)) {
            iconPath = '<svg class="icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M14,17H12V15H10V13H12V15H14M14,9H12V11H14V13H12V11H10V9H12V7H10V5H12V7H14M19,3H5C3.89,3 3,3.89 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5C21,3.89 20.1,3 19,3Z" fill="#909399"/></svg>';
        } else {
            iconPath = '<svg class="icon" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M961.536 531.251c-0.614-3.481-1.843-7.168-3.891-10.445L827.392 306.79v-28.876c0-10.445 0-20.276 0.205-29.901 0.819-89.703 1.433-174.285-101.376-179.2H303.923c-33.587 0-58.368 8.601-76.185 26.624-30.72 30.925-30.31 79.257-29.696 140.288 0 8.601 0.204 17.408 0.204 26.419v38.093c-2.867 2.253-5.324 4.915-7.168 8.192L64.717 523.879c-1.639 2.867-2.663 5.734-3.277 8.806-6.144 12.288-9.626 26.01-9.626 40.345v290.407c0 50.585 41.984 91.75 93.594 91.75h733.184c51.61 0 93.594-41.165 93.594-91.75V573.03c-0.205-14.95-4.096-29.286-10.65-41.779zM861.389 481.28h-33.997v-55.91l33.997 55.91zM271.565 138.65c5.53-5.53 16.384-8.397 32.358-8.397h420.045c36.25 1.843 42.803 11.264 41.78 117.145 0 9.83-0.206 19.866-0.206 30.516V481.28H664.576c-16.998 0-30.925 13.722-30.925 30.925 0 64.307-54.681 116.736-122.06 116.736S389.53 576.512 389.53 512.205c0-16.999-13.722-30.925-30.925-30.925H259.89V262.144c0-9.42 0-18.432-0.205-27.034-0.41-43.008-0.819-83.558 11.879-96.46z m-73.523 279.552v63.078h-36.864l36.864-63.078z m712.294 445.44c0 16.179-14.54 30.105-31.949 30.105H145.203c-17.203 0-31.949-13.721-31.949-30.105V573.03c0-16.179 14.541-30.105 31.95-30.105h185.548c15.155 83.763 90.522 147.456 181.043 147.456s165.888-63.898 181.043-147.456h185.55c17.202 0 31.948 13.721 31.948 30.105v290.612z" fill="#909399"></path><path d="M385.638 278.528H655.77c16.998 0 30.924-13.722 30.924-30.925s-13.721-30.925-30.924-30.925H385.638c-16.998 0-30.924 13.722-30.924 30.925s13.926 30.925 30.924 30.925z m-30.924 70.451c0 16.999 13.721 30.925 30.924 30.925H655.77c16.998 0 30.924-13.722 30.924-30.925 0-17.203-13.721-30.925-30.924-30.925H385.638c-16.998 0-30.924 13.927-30.924 30.925z" fill="#909399"></path></svg>';
        }
        
        return iconPath;
    }

    async function handleUploadSuccess(res, randomClass, file) { // Added file parameter & async
        const fileName = encodeURIComponent(file.name);
        
        const passphrase = $('#passphraseInput').val();
        let originalShareUrl; // Renamed from displaySrc / shareUrl to avoid confusion before shortening

        if (passphrase) {
            // Encrypted share link (keep existing format for encrypted files)
            const fileData = {
                cid: res.Hash,
                filename: file.name,
                size: file.size
            };
            const encryptedData = encryptData(fileData, passphrase);
            originalShareUrl = `${window.location.origin}${window.location.pathname.replace('index.html', '')}share.html?share=${encodeURIComponent(encryptedData)}`;
        } else {
            // Use new compressed format for public files
            const fileData = {
                c: res.Hash,        // cid
                f: file.name,       // filename  
                s: file.size        // size
            };
            const compressedData = base64UrlEncode(JSON.stringify(fileData));
            originalShareUrl = `${window.location.origin}${window.location.pathname.replace('index.html', '')}share.html?d=${compressedData}`;
        }
        
        // Get short URL if enabled
        const finalShareUrl = await getShortUrl(originalShareUrl);
        
        $('#file').val(null);
        $(`.${randomClass}`).find('.progress-inner').addClass('success');
        $(`.${randomClass}`).find('.progress').fadeOut(500, function() {
            $(`.${randomClass}`).removeClass('uploading');
            const urlDisplay = $(`.${randomClass}`).find('.url-display');
            const fileUrlInput = $(`.${randomClass}`).find('.file-url-input');
            fileUrlInput.val(finalShareUrl); // Use final (potentially shortened) URL
            urlDisplay.fadeIn(300);
        });
        
        // Store the URL and CID values in hidden inputs
        $(`.${randomClass}`).find('.data-url').val(finalShareUrl); // Use final (potentially shortened) URL
        $(`.${randomClass}`).find('.data-cid').val(res.Hash);
        $(`.${randomClass}`).find('.data-filename').val(file.name);
        
        // Enable buttons since we have uploaded files
        $('.copyall').removeClass('disabled');
        
        // Success notification
        showToast(_t('upload-success'), 'success');
        
        // Enable batch sharing functionality once files are uploaded
        updateShareSelectedButtonState();

        // Add to history if historyManager is available
        if (window.historyManager) {
            try {
                const historyRecord = window.historyManager.addRecord({
                    filename: file.name,
                    cid: res.Hash,
                    size: file.size,
                    shareUrl: finalShareUrl,
                    isEncrypted: !!passphrase,
                    gateway: 'IPFS Network',
                    uploadDuration: Date.now() - parseInt(randomClass, 36) // Approximate upload time
                });
                console.log('Added to history:', historyRecord);
            } catch (error) {
                console.error('Failed to add to history:', error);
            }
        } else {
            console.warn('History manager not available');
        }
    }

    // 文件夹上传成功处理
    async function handleDirectoryUploadSuccess(dirObj, folderName, totalSize, randomClass) { // Make async
        // Ensure folderName has trailing slash for directory identification
        const directoryName = folderName.endsWith('/') ? folderName : folderName + '/';
        
        // Use compressed format for directory shares too
        const fileData = {
            c: dirObj.Hash,
            f: directoryName, // Use directoryName with trailing slash
            s: totalSize
        };
        const compressedData = base64UrlEncode(JSON.stringify(fileData));
        const originalShareUrl = `${window.location.origin}${window.location.pathname.replace('index.html', '')}share.html?d=${compressedData}`;
        
        const finalShareUrl = await getShortUrl(originalShareUrl); // Get short URL

        $('#file').val(null); // Assuming #file is the general file input, might need #directory.val(null) too
        $('#directory').val(null); 
        $(`.${randomClass}`).find('.progress-inner').addClass('success');
        $(`.${randomClass}`).find('.progress').fadeOut(500, function() {
            $(`.${randomClass}`).removeClass('uploading');
            const urlDisplay = $(`.${randomClass}`).find('.url-display');
            const fileUrlInput = $(`.${randomClass}`).find('.file-url-input');
            fileUrlInput.val(finalShareUrl); // Use final (potentially shortened) URL
            urlDisplay.fadeIn(300);
        });
        $(`.${randomClass}`).find('.data-url').val(finalShareUrl); // Use final (potentially shortened) URL
        $(`.${randomClass}`).find('.data-cid').val(dirObj.Hash);
        $(`.${randomClass}`).find('.data-filename').val(directoryName); // Store directory name with trailing slash
        $('.copyall').removeClass('disabled');
        showToast(_t('upload-success'), 'success');
        updateShareSelectedButtonState();

        // Add to history if historyManager is available
        if (window.historyManager) {
            try {
                const historyRecord = window.historyManager.addRecord({
                    filename: directoryName, // Use directoryName with trailing slash for proper folder identification
                    cid: dirObj.Hash,
                    size: totalSize,
                    shareUrl: finalShareUrl,
                    isEncrypted: false, // Directories are currently not encrypted in this implementation
                    gateway: 'IPFS Network',
                    uploadDuration: Date.now() - parseInt(randomClass.replace('_dir', ''), 36) // Approximate upload time
                });
                console.log('Added directory to history:', historyRecord);
            } catch (error) {
                console.error('Failed to add directory to history:', error);
            }
        } else {
            console.warn('History manager not available');
        }
    }

    function handleError(randomClass, message = _t('upload-error')) {
        $(`.${randomClass}`).find('.progress-inner').addClass('error');
        $(`.${randomClass}`).find('.progress-status').text('Failed');
        $(`.${randomClass}`).removeClass('uploading');
        
        showToast(message, 'error');
        
        setTimeout(() => {
            $(`.${randomClass}`).find('.progress').fadeOut(500);
        }, 3000);
    }

    function formatBytes(bytes, decimals = 2) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }
});

// Add subtle animation when deleting an item
function deleteItem(obj) {
    const item = $(obj).closest('.item');
    item.css('opacity', 0.5).slideUp(300, function() {
        $(this).remove();
        // Check if there are any items left
        updateShareSelectedButtonState();
    });
}

// Function to copy the URL link (either direct or share link)
function copyLinkUrl(button) {
    const item = $(button).closest('.item');
    const textToCopy = item.find('.data-url').val(); // This now holds the share link URL
    
    copyToClipboard(textToCopy);
    // const isProtected = item.find('.data-passphrase-protected').val() === 'true'; // Redundant, share link is always used
    // Simplified toast message as it's always a share link
    showToast(_t('copied-format', {format: _t('copy-share-link')}), 'success');
    
    // Add visual feedback
    $(button).addClass('active');
    setTimeout(() => {
        $(button).removeClass('active');
    }, 300);
}

// Function to copy the CID
function copyCID(button) {
    const item = button.closest('.item');
    const textToCopy = item.querySelector('.data-cid').value;
    
    copyToClipboard(textToCopy);
    showToast(_t('copied-format', {format: 'CID'}), 'success');
    
    // Add visual feedback
    $(button).addClass('active');
    setTimeout(() => {
        $(button).removeClass('active');
    }, 300);
}

// Helper function for copying to clipboard
function copyToClipboard(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
}

// Add this new function specifically for share links if needed, or rely on copyLinkUrl
function copyShareLink(button) {
    // This function is now effectively the same as copyLinkUrl when a passphrase is set
    // because data-url will store the share link.
    // We can simplify by having copyLinkUrl handle both cases based on what's in data-url.
    // The button's onclick is already set dynamically in createFileItem and handleUploadSuccess.
    copyLinkUrl(button);
}


function seeding(res) {
    const gateways = [
        // 主流公共网关
        'https://i0.img2ipfs.com/ipfs/',
        'https://cdn.ipfsscan.io/ipfs/',
        'https://gateway.ipfsscan.io/ipfs/',
        'https://ipfs.io/ipfs/',
        'https://ipfs.crossbell.io/ipfs/',
        'https://gateway.pinata.cloud/ipfs/',
        'https://w3s.link/ipfs/',
        'https://dweb.link/ipfs/',
        // QuickNode gateways
        'https://cake-volume-phrase.quicknode-ipfs.com/ipfs/',
        'https://dswap.quicknode-ipfs.com/ipfs/',
        'https://daa.quicknode-ipfs.com/ipfs/',
        'https://hashscan-ipfs.quicknode-ipfs.com/ipfs/',
        'https://resto.quicknode-ipfs.com/ipfs/',
        'https://within-herd-pitch.quicknode-ipfs.com/ipfs/',
        // ETH related gateways
        'https://eth.sucks/ipfs/',
        'https://ipfs-01.ethquokkaops.io/ipfs/',
        'https://ipfs-02.ethquokkaops.io/ipfs/',
        'https://filebase.truffle.wtf/ipfs/',
        // Other gateways
        'https://ipfs-gateway.gifted.art/ipfs/',
        'https://ipfs.forma.art/ipfs/',
        'https://i18n.opendreamnet.com/ipfs/',
        'https://gateway.ipfs.anarchiststickersarchive.org/ipfs/',
        'https://ipfs.ftso.best/ipfs/',
        'https://ipfs.distri.ai/ipfs/',
        'https://ipfs.dekart.io/ipfs/',
        'https://ipfs.allgram.best/ipfs/',
        'https://ipfs.metaversis.io/ipfs/',
        'https://ipfs-internal.xnftdata.com/ipfs/'
,
    ];
    gateways.forEach(gateway => {
        fetch(gateway + res.Hash)
            .then(response => console.log(`Seeding at ${gateway}: ${response.status}`))
            .catch(error => console.error(`Error seeding at ${gateway}:`, error));
    });
}

function copyAllLinks() {
    let allLinks = '';
    document.querySelectorAll('.data-url').forEach(input => {
        if (input.value) {
            allLinks += `${input.value}\n`;
        }
    });
    
    copyToClipboard(allLinks);
    showToast(_t('copied-all'), 'success');
}

// Enhanced toast notification function
function showToast(message, type = 'info', duration = 3000) {
    const toastId = 'toast-' + Date.now();
    let icon = '';
    
    switch(type) {
        case 'success':
            icon = '<i class="fas fa-check-circle" style="margin-right: 8px;"></i>';
            break;
        case 'error':
            icon = '<i class="fas fa-exclamation-circle" style="margin-right: 8px;"></i>';
            break;
        case 'info':
            icon = '<i class="fas fa-info-circle" style="margin-right: 8px;"></i>';
            break;
    }
    
    const toast = `
        <div id="${toastId}" class="toast ${type}">
            <span class="toast-message">${icon}${message}</span>
            <span class="toast-close">×</span>
        </div>
    `;
    
    $('.toast-container').append(toast);
    
    // Attach close event
    $(`#${toastId} .toast-close`).on('click', function() {
        $(`#${toastId}`).addClass('hide');
        setTimeout(() => {
            $(`#${toastId}`).remove();
        }, 700);
    });
    
    // Auto remove after duration
    setTimeout(() => {
        if ($(`#${toastId}`).length) {
            $(`#${toastId}`).addClass('hide');
            setTimeout(() => {
                $(`#${toastId}`).remove();
            }, 700);
        }
    }, duration);
}

// --- Passphrase Protection Logic ---

function encryptData(data, passphrase) {
    if (!CryptoJS) {
        console.error("CryptoJS not loaded!");
        showToast(_t('encryption-failed'), 'error');
        return null;
    }
    try {
        const encrypted = CryptoJS.AES.encrypt(JSON.stringify(data), passphrase).toString();
        return encrypted;
    } catch (e) {
        console.error("Encryption failed:", e);
        showToast(_t('encryption-failed'), 'error');
        return null;
    }
}

function decryptData(encryptedData, passphrase) {
    if (!CryptoJS) {
        console.error("CryptoJS not loaded!");
        showToast(_t('decryption-failed'), 'error');
        return null;
    }
    try {
        const bytes = CryptoJS.AES.decrypt(encryptedData, passphrase);
        const decryptedString = bytes.toString(CryptoJS.enc.Utf8);
        if (!decryptedString) {
            return null; // Decryption failed (e.g., wrong key)
        }
        return JSON.parse(decryptedString);
    } catch (e) {
        // This catch is important for invalid JSON after "successful" decryption with wrong key
        console.error("Decryption resulted in invalid data or failed:", e);
        return null;
    }
}

function checkAccessMode() {
    if (window.location.hash && window.location.hash.startsWith('#share=')) {
        // Legacy hash-based share links - redirect to new share.html page
        const encryptedPayload = window.location.hash.substring('#share='.length);
        if (encryptedPayload) {
            window.location.href = `share.html?share=${encodeURIComponent(encryptedPayload)}`;
            return;
        }
    }
    
    // Not a share link, show normal UI
    $('.container').show();
    $('#shareAccessPrompt').hide().data('payload', '');
}

function displayPassphrasePrompt(encryptedPayload) {
    $('.container').hide(); // Hide main upload UI
    $('#shareAccessPrompt').data('payload', encryptedPayload).css('display', 'flex');
    $('#accessPassphraseInput').val('').focus();
    $('#passphraseError').text('');
    // Ensure translations are applied if language changes while prompt is hidden
    $('#shareAccessPrompt').find('[data-translate]').each(function() {
        $(this).text(_t($(this).data('translate')));
    });
}

function handlePassphraseSubmit(encryptedPayload, enteredPassphrase) {
    if (!enteredPassphrase) {
        $('#passphraseError').text(_t('passphrase-incorrect')); // Or a "passphrase cannot be empty" message
        return;
    }

    const decrypted = decryptData(encryptedPayload, enteredPassphrase);

    if (decrypted && decrypted.cid && decrypted.filename) {
        showToast(_t('accessing-file'), 'info', 2000);
        // Redirect to share.html with the decrypted information
        window.location.href = `share.html?cid=${decrypted.cid}&filename=${encodeURIComponent(decrypted.filename)}&size=${decrypted.size || 0}`;
    } else {
        $('#passphraseError').text(_t('passphrase-incorrect'));
        $('#accessPassphraseInput').val(''); // Clear input on failure
    }
}

// Listen for hash changes to re-evaluate access mode (e.g., if user manually changes hash)
$(window).on('hashchange', checkAccessMode);

// --- Batch Share Passphrase Modal Logic ---
function promptBatchSharePassphrase() {
    const selectedItems = $('.file-select-checkbox:checked').closest('.item');
    if (selectedItems.length === 0) {
        showToast(_t('no-files-selected'), 'error');
        return;
    }

    // Show the modal
    $('#batchSharePassphraseModal').css('display', 'flex');
    $('#batchPassphraseInput').val(''); // Clear previous input
    $('#batchPassphraseInput').focus();

    // Translate modal elements
    $('#batchSharePassphraseModal h3').text(_t('batch-share-passphrase-title'));
    $('#batchPassphraseInput').attr('placeholder', _t('batch-share-passphrase-placeholder'));
    $('#confirmBatchSharePassphrase').text(_t('batch-share-confirm-copy'));
    $('#cancelBatchSharePassphrase').text(_t('batch-share-cancel'));
}

function closeBatchSharePassphraseModal() {
    $('#batchSharePassphraseModal').hide();
}

// Attach event listeners for the batch share passphrase modal
$(document).ready(() => {
    // ... existing ready listeners ...

    $('#confirmBatchSharePassphrase').on('click', async () => { // Make async
        const passphrase = $('#batchPassphraseInput').val();
        await shareBatchFiles(passphrase); // Pass the passphrase and await
        closeBatchSharePassphraseModal();
    });

    $('#cancelBatchSharePassphrase').on('click', () => {
        closeBatchSharePassphraseModal();
    });

    // Allow pressing Enter to submit batch passphrase
    $('#batchPassphraseInput').on('keypress', (e) => {
        if (e.which === 13) { // Enter key
            $('#confirmBatchSharePassphrase').click();
        }
    });
});

// Modified function to accept passphrase as an argument
async function shareBatchFiles(passphrase) { // passphrase is now an argument, make async
    const selectedItems = $('.file-select-checkbox:checked').closest('.item');
    
    // This check is technically redundant if promptBatchSharePassphrase already checks,
    // but good for safety if shareBatchFiles is ever called directly.
    if (selectedItems.length === 0) {
        showToast(_t('no-files-selected'), 'error');
        return;
    }
    
    // Collect file data
    const files = [];
    selectedItems.each(function() {
        const item = $(this);
        const cid = item.find('.data-cid').val();
        const filename = item.find('.data-filename').val();
        // Fix: Get size from hidden input or parse from display text more reliably
        const sizeText = item.find('.desc__size').text();
        let size = 0;
        try {
            // Extract size from text like "文件大小: 1.2 MB" or "File size: 1.2 MB"
            const sizeMatch = sizeText.match(/[\d.,]+\s*(B|KB|MB|GB)/i);
            if (sizeMatch) {
                const value = parseFloat(sizeMatch[0].replace(/,/g, ''));
                const unit = sizeMatch[1].toUpperCase();
                const multipliers = { 'B': 1, 'KB': 1024, 'MB': 1024*1024, 'GB': 1024*1024*1024 };
                size = Math.round(value * (multipliers[unit] || 1));
            }
        } catch (e) {
            console.warn('Failed to parse file size:', sizeText, e);
        }
        
        const isProtected = item.find('.data-passphrase-protected').val() === 'true';
        
        if (cid && filename) {
            files.push({
                cid: cid,
                filename: filename,
                size: size,
                isProtected: isProtected
            });
        }
    });
    
    if (files.length === 0) {
        showToast(_t('selected-files-invalid'), 'error');
        return;
    }
    
    let batchShareUrlToCopy; // Variable to hold the URL before copying

    // Create batch share
    if (passphrase) {
        // Encrypt the batch data with passphrase
        const encryptedBatch = encryptData(files, passphrase);
        if (encryptedBatch) {
            const originalBatchShareUrl = `${window.location.origin}${window.location.pathname.replace('index.html', '')}batch-share.html?share=${encodeURIComponent(encryptedBatch)}`;
            batchShareUrlToCopy = await getShortUrl(originalBatchShareUrl);            
            copyToClipboard(batchShareUrlToCopy);
            showToast(_t('batch-share-link-copied'), 'success');
        } else {
            showToast(_t('batch-encryption-failed'), 'error');
            return;        
        }
    } else {
        // Use new compressed format for non-encrypted batch shares
        const compressedData = base64UrlEncode(JSON.stringify(files));
        const originalBatchShareUrl = `${window.location.origin}${window.location.pathname.replace('index.html', '')}batch-share.html?d=${compressedData}`;
        batchShareUrlToCopy = await getShortUrl(originalBatchShareUrl); // Get short URL
        
        copyToClipboard(batchShareUrlToCopy);
        showToast(_t('batch-share-link-copied'), 'success');
    }
}

// 新增：根据文件数量和大小自动选择是否压缩文件夹
function shouldCompressFolder(fileList) {
    if (!fileList || !fileList.length) return false;
    // 计算文件夹大小
    let totalSize = 0;
    Array.from(fileList).forEach(f => totalSize += f.size);
    const fileCount = fileList.length;

    // 超过阈值则压缩
    return totalSize > folderUploadConfig.maxFolderSize || fileCount > folderUploadConfig.maxFileCount;
}

// New function to update the state of the "Share Selected" button
function updateShareSelectedButtonState() {
    const anyFilesUploaded = $('.item').length > 0;
    const anyFilesSelected = $('.file-select-checkbox:checked').length > 0;
    
    // Update toggle all checkbox state
    $('#toggleAllFiles').prop('disabled', !anyFilesUploaded);
    
    // Update copy all button state
    if (anyFilesUploaded) {
        $('.copyall').removeClass('disabled');
    } else {
        $('.copyall').addClass('disabled');
    }
    
    // Update share selected button state
    if (!anyFilesUploaded || !anyFilesSelected) {
        $('#shareSelected').addClass('disabled');
    } else {
        $('#shareSelected').removeClass('disabled');
    }
}

// 判断是否为文件夹上传
function isDirectoryUpload(fileList) {
    if (!fileList || !fileList.length) return false;
    // webkitRelativePath 有值说明是文件夹上传
    return Array.from(fileList).some(f => f.webkitRelativePath && f.webkitRelativePath.length > 0);
}

// 检查拖拽项是否包含目录
function hasDirectory(items) {
    for (let i = 0; i < items.length; i++) {
        if (items[i].webkitGetAsEntry && items[i].webkitGetAsEntry().isDirectory) {
            return true;
        }
    }
    return false;
}

// 递归获取拖拽文件夹下所有文件
function getFilesFromDataTransferItems(items) {
    return new Promise(resolve => {
        let files = [];
        let pending = 0;
        function traverse(entry, path = '') {
            if (entry.isFile) {
                pending++;
                entry.file(file => {
                    // 确保设置正确的相对路径
                    file.webkitRelativePath = path + file.name;
                    files.push(file);
                    pending--;
                    if (pending === 0) resolve(files);
                });
            } else if (entry.isDirectory) {
                const reader = entry.createReader();
                pending++;
                reader.readEntries(entries => {
                    entries.forEach(e => traverse(e, path + entry.name + '/'));
                    pending--;
                    if (pending === 0) resolve(files);
                });
            }
        }
        for (let i = 0; i < items.length; i++) {
            const entry = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry();
            if (entry) traverse(entry, '');
        }
    });
}

// 文件夹上传
function uploadDirectory(fileList) {
    if (!fileList || !fileList.length) return;
    // 计算总大小和文件数量
    let totalSize = 0;
    Array.from(fileList).forEach(f => totalSize += f.size);
    const fileCount = fileList.length;

    // 限制：最大 100MB，总文件数不超过 500
    const maxFolderSize = 5242880 * 20;  // 100MB
    const maxFolderFiles = 500;
    if (totalSize > maxFolderSize) {
        showToast(`文件夹大小不可超过 ${maxFolderSize/1024/1024} MB`, 'error');
        return;
    }
    if (fileCount > maxFolderFiles) {
        showToast(`文件夹内文件数量不可超过 ${maxFolderFiles} 个`, 'error');
        return;
    }

    // 修复文件夹名称提取逻辑
    let folderName = '';
    if (fileList[0].webkitRelativePath) {
        // 从相对路径中提取顶级文件夹名称
        const pathParts = fileList[0].webkitRelativePath.split('/');
        folderName = pathParts[0]; // 取第一个部分作为文件夹名称
    } else {
        // 如果没有相对路径，使用默认名称
        folderName = 'uploaded_folder';
    }
    
    // 判断是否需要压缩
    const needsCompression = folderUploadConfig.compressLargeFolder && 
        (totalSize > folderUploadConfig.maxFolderSize || fileCount > folderUploadConfig.maxFileCount);
    
    if (needsCompression) {
        // 添加压缩任务到队列
        uploadQueue.add(async () => {
            try {
                const zipFile = await compressFolderToZip(fileList, folderName);
                // 上传压缩后的ZIP文件
                return uploadToImg2IPFS(zipFile);
            } catch (error) {
                console.error('压缩上传失败:', error);
                showToast(_t('compress-upload-failed', {default: '压缩上传失败'}), 'error');
                throw error;
            }
        });
    } else {
        // 将文件夹上传任务添加到队列（原始方式）
        uploadQueue.add(() => uploadDirectoryToIPFS(fileList, folderName, totalSize));
    }
}

// 创建文件夹上传条目
function createDirectoryItem(folderName, totalSize, randomClass) {
    // Remove trailing slash for display only
    const displayName = folderName.endsWith('/') ? folderName.slice(0, -1) : folderName;
    return `
        <div class="item ${randomClass}">
            <div class="file">
                <input type="checkbox" class="file-select-checkbox" title="${_t('select-for-batch-sharing')}">
                <svg class="icon" viewBox="0 0 24 24" width="32" height="32"><path d="M10 4H2v16h20V6H12l-2-2z" fill="#f7ba2a"/><path d="M2 20V4h8l2 2h10v14z" fill="none"/></svg>
                <div class="desc">
                    <div class="desc__name">${displayName}</div>
                    <div class="desc__size">${_t('file-size', {size: formatBytes(totalSize)})}</div>
                </div>
                <a href="javascript:void(0);" class="link copy-primary-link" title="${_t('copy-share-link')}" onclick="copyLinkUrl(this); return false;">
                    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" class="icon-copy">
                        <path d="M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z" fill="#909399"/>
                    </svg>
                </a>
                <a href="javascript:void(0);" class="link" title="CID" onclick="copyCID(this); return false;">
                    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" class="icon-copy-cid">
                        <path d="M14,8H10V6H14V8M20,4V20C20,21.1 19.1,22 18,22H6C4.9,22 4,21.1 4,20V4C4,2.9 4.9,2 6,2H18C19.1,2 20,2.9 20,4M18,13H6V20H18V13M18,4H6V11H18V4H14,15H10V17H14V15Z" fill="#909399"/>
                    </svg>
                </a>
                <a title="delete" class="link" onclick="deleteItem(this); return false;">
                    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" class="icon-delete">
                        <path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z" fill="#909399"/>
                    </svg>
                </a>
            </div>
            <div class="progress">
                <div class="progress-bar">
                    <div class="progress-inner"></div>
                </div>
                <div class="progress-status">0%</div>
            </div>
            <div class="url-display" style="display: none; margin-top: 8px;">
                <input type="text" class="file-url-input" style="width: 100%; padding: 6px; border: 1px solid #dcdfe6; border-radius: 4px; box-sizing: border-box;" readonly>
            </div>
            <input type="hidden" class="data-url" value="">
            <input type="hidden" class="data-cid" value="">
            <input type="hidden" class="data-filename" value="${folderName.endsWith('/') ? folderName : folderName + '/'}">
            <input type="hidden" class="data-passphrase-protected" value="false">
        </div>
    `;
}

// Add Base64URL functions at the top of the file
function base64UrlEncode(str) {
    return btoa(unescape(encodeURIComponent(str)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

function base64UrlDecode(str) {
    // Add padding
    str += '='.repeat((4 - str.length % 4) % 4);
    // Replace URL-safe characters
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    return decodeURIComponent(escape(atob(str)));
}

// --- History Management Integration ---
function renderHistoryList(items) {
    const container = document.getElementById('historyList');
    container.innerHTML = '';

    items.forEach(item => {
        const itemElement = createHistoryItem(item);
        container.appendChild(itemElement);
    });
}

function createHistoryItem(item) {
    const div = document.createElement('div');
    div.className = 'history-item';
    div.dataset.id = item.id;

    const fileIcon = getFileTypeIcon(item.filename);
    const formattedDate = new Date(item.timestamp).toLocaleString();
    const fileSize = item.size ? formatBytes(item.size) : 'Unknown';

    div.innerHTML = `
        <div class="item-checkbox">
            <input type="checkbox" onchange="toggleItemSelection('${item.id}')">
        </div>
        <div class="item-icon">${fileIcon}</div>
        <div class="item-details">
            <div class="item-name">${escapeHtml(item.filename)}</div>
            <div class="item-meta">
                <span><i class="fas fa-calendar"></i>${formattedDate}</span>
                <span><i class="fas fa-database"></i>${fileSize}</span>
                <span><i class="fas fa-tag"></i>${item.type}</span>
                ${item.isEncrypted ? '<span class="encrypted-badge"><i class="fas fa-lock"></i>Encrypted</span>' : ''}
            </div>
        </div>
        <div class="item-actions">
            <button class="btn-icon" onclick="copyShareUrl('${escapeHtml(item.shareUrl)}')" title="Copy Share URL">
                <i class="fas fa-copy"></i>
            </button>
            <button class="btn-icon" onclick="copyCID('${escapeHtml(item.cid)}')" title="Copy CID">
                <i class="fas fa-fingerprint"></i>
            </button>
            <button class="btn-icon btn-danger" onclick="deleteItem('${item.id}')" title="Delete">
                <i class="fas fa-trash"></i>
            </button>
        </div>
    `;

    return div;
}

// Add helper function to escape HTML
function escapeHtml(text) {
    const map = {

        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, function(m) { return map[m]; });
}

