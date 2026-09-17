$ErrorActionPreference = 'Stop'

$inputPath = 'C:\Users\heman\Downloads\CBT\MockTest-main\docs\JEE_Examination_Portal_Client_Operations_Guide.docx'
$outputDir = 'C:\Users\heman\Downloads\CBT\MockTest-main\tmp\client-guide-render'
$outputPath = Join-Path $outputDir 'JEE_Examination_Portal_Client_Operations_Guide.pdf'

New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

$word = $null
$document = $null
try {
    Write-Output 'Starting Word'
    $word = New-Object -ComObject Word.Application
    Write-Output 'Word started'
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $word.AutomationSecurity = 3
    Write-Output 'Opening document'
    $document = $word.Documents.Open($inputPath, $false, $true)
    Write-Output 'Document opened'
    $document.SaveAs2($outputPath, 17)
    Write-Output 'PDF exported'
}
finally {
    if ($null -ne $document) {
        $document.Close($false)
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($document)
    }
    if ($null -ne $word) {
        $word.Quit()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}

Write-Output $outputPath
