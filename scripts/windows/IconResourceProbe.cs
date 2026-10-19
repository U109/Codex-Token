using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

// 从最终资源提取图标并计算像素摘要，验证安装器和助手使用同一套图标。
public static class IconResourceProbe
{
    [DllImport("user32.dll", EntryPoint = "PrivateExtractIconsW", CharSet = CharSet.Unicode)]
    private static extern uint PrivateExtractIcons(
        string file,
        int index,
        int width,
        int height,
        IntPtr[] handles,
        uint[] ids,
        uint count,
        uint flags
    );

    [DllImport("user32.dll")]
    private static extern bool DestroyIcon(IntPtr icon);

    public static Bitmap Extract(string file, int size)
    {
        var handles = new IntPtr[1];
        uint found = PrivateExtractIcons(file, 0, size, size, handles, new uint[1], 1, 0);
        if (found != 1 || handles[0] == IntPtr.Zero)
            throw new Exception("native-icon-resource-missing");
        try
        {
            using (var icon = Icon.FromHandle(handles[0]))
            {
                return icon.ToBitmap();
            }
        }
        finally
        {
            DestroyIcon(handles[0]);
        }
    }

    public static string PixelHash(Bitmap bitmap)
    {
        byte[] bytes = new byte[bitmap.Width * bitmap.Height * 4];
        for (int y = 0; y < bitmap.Height; y++)
        for (int x = 0; x < bitmap.Width; x++)
            Array.Copy(
                BitConverter.GetBytes(bitmap.GetPixel(x, y).ToArgb()),
                0,
                bytes,
                (y * bitmap.Width + x) * 4,
                4
            );
        using (var sha = SHA256.Create())
        {
            return BitConverter
                .ToString(sha.ComputeHash(bytes))
                .Replace("-", "")
                .ToLowerInvariant();
        }
    }
}
